// Unit finite state machine. Borrowed pattern from openage's "ability/task"
// model: a unit is always in exactly one state; commands rewrite its state.
//
// States:
//   idle      — auto-target if applicable; otherwise stand still
//   moving    — follow a path of tiles, then enter idle
//   gathering — at a resource node; tick wood/food/gold/stone into carrying;
//               when full, transition to returning
//   returning — pathing to nearest dropoff; on arrival, deposit and head back
//   building  — at a construction site; pour progress into it
//   attacking — at melee/range distance from target; swing on cadence
//   attackMove— move toward final target but auto-aggro along the way
//
// Two rules keep crowds from deadlocking (50 units converging on one target
// used to freeze the whole sim):
//   1. Intent completion is OPPORTUNISTIC: while moving, a unit checks every
//      tick whether its queued intent (attack/gather/build/deposit) is already
//      achievable from where it stands, instead of insisting on reaching an
//      exact tile center that the crowd may make unreachable.
//   2. Stuck units (no progress toward their next waypoint) re-path once with
//      backoff, then give up and go idle rather than shoving forever.

import type {
  Command,
  Entity,
  ResourceKind,
  TilePos,
  UnitState,
  Vec2,
} from '@/core/types';
import { World } from '@/core/world';
import { findPath, findPathToAdjacent } from '@/core/pathfinding';
import { dist, tileCenter, worldToTile } from '@/util/math';
import { UNIT_DEFS } from '@/config/units';
import { TILE_SIZE } from '@/config/constants';

const BUILD_INTERACTION_RANGE = 36;

export interface FSMDeps {
  world: World;
  now: number;
  entities: Map<number, Entity>;
  byOwner: (owner: number) => Entity[];
  resources: Record<number, Record<ResourceKind, number>>; // per-player bag
  onUnitDied: (e: Entity) => void;
  onResourceDeposited: (owner: number, kind: ResourceKind, amt: number, dropoff?: Entity) => void;
  onBuildingCompleted: (e: Entity) => void;
  onProjectile?: (from: Vec2, to: Vec2, color: string) => void;
  onHit?: (target: Entity, dmg: number) => void;
}

// Cap on per-unit command queue depth. Prevents runaway accumulation when an
// AI re-issues the same intent every tick.
const MAX_QUEUE = 4;

// How long (seconds of zero progress) before a moving unit re-paths, and how
// long after that before it gives up and goes idle.
const STUCK_REPATH_AFTER = 0.9;
const STUCK_GIVE_UP_AFTER = 2.4;

// While walking an attack-move leg, scan for enemies this often.
const ACQUIRE_INTERVAL = 0.25;

/** Sight used to pick up targets during attack-move / when stuck in a brawl. */
function acquireRange(unit: Entity): number {
  return Math.max(unit.attackRange ?? 0, 40) + 160;
}

function pushQueue(unit: Entity, cmd: Command) {
  if (!unit.commandQueue) unit.commandQueue = [];
  // De-dup against the WHOLE queue — AI loops re-issue the same intent every
  // tick and a queue of four identical attacks helps nobody.
  for (const q of unit.commandQueue) {
    if (q.kind !== cmd.kind) continue;
    if ('targetId' in cmd && 'targetId' in q && (cmd as any).targetId === (q as any).targetId) return;
    if ('pos' in cmd && 'pos' in q && (cmd as any).pos?.x === (q as any).pos?.x && (cmd as any).pos?.y === (q as any).pos?.y) return;
  }
  unit.commandQueue.unshift(cmd);
  if (unit.commandQueue.length > MAX_QUEUE) unit.commandQueue.length = MAX_QUEUE;
}

export function executeCommand(unit: Entity, cmd: Command, deps: FSMDeps) {
  switch (cmd.kind) {
    case 'stop':
      unit.state = { kind: 'idle' };
      unit.commandQueue = [];
      break;
    case 'move': {
      const path = computePathTo(unit, cmd.pos, deps);
      unit.state = path
        ? { kind: 'moving', path, pathIndex: 0, finalTarget: cmd.pos }
        : { kind: 'idle' };
      break;
    }
    case 'attackMove': {
      const path = computePathTo(unit, cmd.pos, deps);
      // Even if no path right now, hold the intent so auto-acquire can fire.
      if (path) {
        unit.state = { kind: 'moving', path, pathIndex: 0, finalTarget: cmd.pos };
        pushQueue(unit, { kind: 'attackMove', pos: cmd.pos });
      } else {
        // Walled off: chew through the nearest hostile building (walls
        // included) instead of idling at the barrier. The attack-move intent
        // stays queued so the march resumes once the breach is open. Only
        // runs on path failure — never per tick.
        const blocker = findNearestEnemyBuilding(unit, deps, 600);
        if (blocker && (unit.attackDmg ?? 0) > 0) {
          unit.state = { kind: 'attacking', targetId: blocker.id };
          pushQueue(unit, { kind: 'attackMove', pos: cmd.pos });
        } else {
          unit.state = { kind: 'attackMove', finalTarget: cmd.pos };
        }
      }
      break;
    }
    case 'gather': {
      const node = deps.entities.get(cmd.targetId);
      if (!node || node.kind !== 'resource' || (node.resourceRemaining ?? 0) <= 0) {
        unit.state = { kind: 'idle' };
        break;
      }
      // Only gatherers gather (villagers). Others ignore the command.
      if (!unit.gatherRate) {
        unit.state = { kind: 'idle' };
        break;
      }
      // Walk up to it, then gather.
      moveTowardEntity(unit, node, deps);
      // Queue the gather to fire on arrival.
      pushQueue(unit, { kind: 'gather', targetId: cmd.targetId });
      break;
    }
    case 'returnResource': {
      const dropoff = deps.entities.get(cmd.targetId);
      if (!dropoff) break;
      moveTowardEntity(unit, dropoff, deps);
      pushQueue(unit, { kind: 'returnResource', targetId: cmd.targetId });
      break;
    }
    case 'build': {
      const target = deps.entities.get(cmd.targetId);
      if (!target || target.kind !== 'building') {
        unit.state = { kind: 'idle' };
        break;
      }
      const def = UNIT_DEFS[unit.typeId];
      if (!def?.canBuild) {
        unit.state = { kind: 'idle' };
        break;
      }
      moveTowardEntity(unit, target, deps);
      pushQueue(unit, { kind: 'build', targetId: cmd.targetId });
      break;
    }
    case 'attack': {
      const target = deps.entities.get(cmd.targetId);
      if (!target) break;
      // Already in range? Fight from here — no walking to a tile center that
      // a crowd may have made unreachable.
      if (inAttackRange(unit, target)) {
        unit.state = { kind: 'attacking', targetId: target.id };
        break;
      }
      moveTowardEntity(unit, target, deps);
      pushQueue(unit, { kind: 'attack', targetId: cmd.targetId });
      break;
    }
  }
}

function computePathTo(unit: Entity, dst: Vec2, deps: FSMDeps): TilePos[] | null {
  const start = worldToTile(unit.pos);
  const goal = worldToTile(dst);
  // Direct A* attempt.
  const direct = findPath(deps.world, start, goal);
  if (direct !== null) return direct;
  // The goal is unreachable (likely inside a building or surrounded). Look for
  // a passable tile in an expanding ring around the goal and route there.
  for (let r = 1; r <= 6; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = goal.tx + dx;
        const ty = goal.ty + dy;
        if (!deps.world.inBounds(tx, ty)) continue;
        if (!deps.world.isPassable(tx, ty)) continue;
        const p = findPath(deps.world, start, { tx, ty });
        if (p !== null) return p;
      }
    }
  }
  return null;
}

function moveTowardEntity(unit: Entity, target: Entity, deps: FSMDeps) {
  const start = worldToTile(unit.pos);
  let path: TilePos[] | null = null;
  if (target.footprintTiles && target.footprintTiles.length > 0) {
    path = findPathToAdjacent(deps.world, start, target.footprintTiles);
  } else {
    const goal = worldToTile(target.pos);
    path = findPath(deps.world, start, goal);
  }
  // Empty path means we're already at/adjacent to the goal: stay idle so the
  // command queue can re-evaluate (attack, gather, etc.) instead of spinning
  // through a no-op move.
  if (path && path.length === 0) {
    unit.state = { kind: 'idle' };
    return;
  }
  unit.state = path
    ? { kind: 'moving', path, pathIndex: 0, finalTarget: target.pos }
    : { kind: 'idle' };
}

// Tick a single unit forward by dt seconds.
export function tickUnit(unit: Entity, dt: number, deps: FSMDeps) {
  if (unit.dead) return;
  if (!unit.state) unit.state = { kind: 'idle' };
  // Stunned units (Indrastra) do nothing until the stun expires.
  if (unit.stunnedUntil !== undefined && deps.now < unit.stunnedUntil) return;

  const s = unit.state;
  switch (s.kind) {
    case 'idle':
      tickIdle(unit, deps);
      break;
    case 'moving':
      tickMoving(unit, dt, deps);
      break;
    case 'gathering':
      tickGathering(unit, dt, deps);
      break;
    case 'returning':
      tickReturning(unit, dt, deps);
      break;
    case 'building':
      tickBuilding(unit, dt, deps);
      break;
    case 'attacking':
      tickAttacking(unit, dt, deps);
      break;
    case 'attackMove':
      // Look for any enemy entity in a generous sight range (units OR buildings).
      const enemy = findEnemyInRange(unit, deps, Math.max((unit.attackRange ?? 0) * 6, 220));
      if (enemy) {
        unit.state = { kind: 'attacking', targetId: enemy.id };
      } else {
        const path = computePathTo(unit, s.finalTarget, deps);
        if (path && path.length > 0) {
          unit.state = { kind: 'moving', path, pathIndex: 0, finalTarget: s.finalTarget };
          // Keep the attack-move intent queued so we resume after the walk.
          pushQueue(unit, { kind: 'attackMove', pos: s.finalTarget });
        } else if (path === null) {
          // Target unreachable (walled off): siege the nearest hostile
          // building so waves grind through walls instead of idling. Cheap:
          // only runs on path failure, and the state transitions away.
          const blocker = findNearestEnemyBuilding(unit, deps, 600);
          if (blocker && (unit.attackDmg ?? 0) > 0) {
            unit.state = { kind: 'attacking', targetId: blocker.id };
            pushQueue(unit, { kind: 'attackMove', pos: s.finalTarget });
          } else {
            unit.state = { kind: 'idle' };
          }
        } else {
          // Empty path — already at the destination.
          unit.state = { kind: 'idle' };
        }
      }
      break;
  }
}

/**
 * While moving (or idle), check whether the head of the command queue is
 * already achievable from the unit's current position and transition directly
 * if so. Returns true when the unit changed state.
 *
 * attackMove is special: it is NOT popped — the unit acquires a target,
 * fights, and the queued attackMove resumes the march afterwards.
 */
function tryCompleteIntent(unit: Entity, deps: FSMDeps): boolean {
  const queue = unit.commandQueue;
  if (!queue || queue.length === 0) return false;
  const head = queue[0];
  switch (head.kind) {
    case 'attack': {
      const target = deps.entities.get(head.targetId);
      if (!target || target.dead) { queue.shift(); return false; }
      if (inAttackRange(unit, target)) {
        queue.shift();
        unit.state = { kind: 'attacking', targetId: target.id };
        return true;
      }
      return false;
    }
    case 'gather': {
      const node = deps.entities.get(head.targetId);
      if (!node || node.dead || (node.resourceRemaining ?? 0) <= 0) return false; // idle path handles renewal
      if (isAdjacentToFootprint(worldToTile(unit.pos), node.footprintTiles ?? [])) {
        queue.shift();
        unit.state = { kind: 'gathering', targetId: node.id, resource: node.resourceKind! };
        return true;
      }
      return false;
    }
    case 'build': {
      const site = deps.entities.get(head.targetId);
      if (!site || site.dead || !site.isConstructionSite) { queue.shift(); return false; }
      if (isAdjacentToFootprint(worldToTile(unit.pos), site.footprintTiles ?? [])) {
        queue.shift();
        unit.state = { kind: 'building', targetId: site.id };
        return true;
      }
      return false;
    }
    case 'returnResource': {
      const dropoff = deps.entities.get(head.targetId);
      if (!dropoff || dropoff.dead) { queue.shift(); return false; }
      if (dropoff.footprintTiles && isAdjacentToFootprint(worldToTile(unit.pos), dropoff.footprintTiles)) {
        queue.shift();
        depositAndResume(unit, dropoff, deps);
        return true;
      }
      return false;
    }
    case 'attackMove': {
      // Mid-march aggro: throttled scan; keep the march queued.
      if (deps.now < (unit.nextAcquireAt ?? 0)) return false;
      unit.nextAcquireAt = deps.now + ACQUIRE_INTERVAL;
      if ((unit.attackDmg ?? 0) <= 0) return false;
      const enemy = findEnemyInRange(unit, deps, acquireRange(unit));
      if (enemy) {
        unit.state = { kind: 'attacking', targetId: enemy.id };
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}

/** Deposit carried resources at `dropoff`, then resume gathering if possible. */
function depositAndResume(unit: Entity, dropoff: Entity, deps: FSMDeps) {
  if (unit.carrying) {
    deps.onResourceDeposited(unit.owner, unit.carrying.resource, unit.carrying.amount, dropoff);
    unit.carrying = undefined;
  }
  const source = findLastGatherSource(unit, deps);
  if (source) {
    executeCommand(unit, { kind: 'gather', targetId: source.id }, deps);
  } else {
    unit.state = { kind: 'idle' };
  }
}

function tickIdle(unit: Entity, deps: FSMDeps) {
  // If there are queued commands left over from a "walk-up-then-do" sequence,
  // pop the next one now.
  if (tryCompleteIntent(unit, deps)) return;
  if (unit.commandQueue && unit.commandQueue.length > 0) {
    const next = unit.commandQueue.shift()!;
    // For gather/build/return we may already be in range; otherwise re-path.
    switch (next.kind) {
      case 'gather': {
        const node = deps.entities.get(next.targetId);
        if (!node || (node.resourceRemaining ?? 0) <= 0) {
          // Find a fresh nearby node of the same resource; if none and we're
          // carrying something, at least bank it.
          const fresh = node ? findClosestResource(unit, node.typeId, deps) : null;
          if (fresh) {
            executeCommand(unit, { kind: 'gather', targetId: fresh.id }, deps);
          } else if (unit.carrying && unit.carrying.amount > 0) {
            const dropoff = findNearestDropoff(unit, unit.carrying.resource, deps);
            if (dropoff) executeCommand(unit, { kind: 'returnResource', targetId: dropoff.id }, deps);
          }
          return;
        }
        executeCommand(unit, next, deps);
        return;
      }
      case 'returnResource':
      case 'build':
      case 'attack': {
        // Not achievable from here (tryCompleteIntent already checked) — walk up.
        // Throttle the implied re-path so a blocked unit doesn't run A* every tick.
        if (deps.now < (unit.nextRepathAt ?? 0)) {
          unit.commandQueue.unshift(next);
          return;
        }
        unit.nextRepathAt = deps.now + 0.5 + (unit.id % 8) * 0.06;
        executeCommand(unit, next, deps);
        return;
      }
      case 'attackMove':
        unit.state = { kind: 'attackMove', finalTarget: next.pos };
        return;
      case 'move':
      case 'stop':
        executeCommand(unit, next, deps);
        return;
    }
  }
  // Truly idle.
}

// Cached pointer to the resource node a villager was last gathering from.
// Stored on the unit object (not in types because it's a runtime detail).
function findLastGatherSource(unit: Entity, deps: FSMDeps): Entity | null {
  const last = (unit as any)._lastSourceId as number | undefined;
  if (last) {
    const e = deps.entities.get(last);
    if (e && !e.dead && (e.resourceRemaining ?? 0) > 0) return e;
  }
  return null;
}

function findClosestResource(unit: Entity, typeId: string, deps: FSMDeps): Entity | null {
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const e of deps.entities.values()) {
    if (e.kind !== 'resource' || e.dead) continue;
    if (e.typeId !== typeId) continue;
    if ((e.resourceRemaining ?? 0) <= 0) continue;
    const d = dist(unit.pos, e.pos);
    if (d < bestD) { best = e; bestD = d; }
  }
  return best;
}

function tickMoving(unit: Entity, dt: number, deps: FSMDeps) {
  const s = unit.state as Extract<UnitState, { kind: 'moving' }>;

  // Opportunistic completion: if the thing we're walking toward is already
  // doable from here (crowd carried us into range, target moved closer, ...),
  // do it now instead of insisting on the exact tile.
  if (tryCompleteIntent(unit, deps)) return;

  if (s.pathIndex >= s.path.length) {
    unit.state = { kind: 'idle' };
    return;
  }
  const nextTile = s.path[s.pathIndex];
  const target = tileCenter(nextTile.tx, nextTile.ty);
  const dx = target.x - unit.pos.x;
  const dy = target.y - unit.pos.y;
  const d = Math.hypot(dx, dy);

  // ----- Speed shaping for natural movement -----
  // Base step. We then apply two scales:
  //   * Turn penalty: while the heading is misaligned, units slow down so the
  //     visible motion follows where they're facing (no sideways skating).
  //   * Arrival slowdown: when within `arriveR` of the FINAL goal, decelerate
  //     smoothly to zero over the last leg. Without this, the unit snap-stops.
  let step = (unit.speed ?? 0) * dt;
  const arriveR = 28; // px from final target where we begin decelerating
  if (s.path.length > 0) {
    const last = s.path[s.path.length - 1];
    const goal = tileCenter(last.tx, last.ty);
    const goalDist = Math.hypot(goal.x - unit.pos.x, goal.y - unit.pos.y);
    if (goalDist < arriveR) {
      const t = goalDist / arriveR;          // 0 at goal → 1 at arriveR
      step *= 0.25 + 0.75 * t;                // never drop below 25% so we still finish
    }
    // Arrival tolerance for plain moves: close enough to the destination is
    // done — crowds around the goal must not stall the walker forever.
    if (goalDist <= Math.max(6, unit.radius * 0.8) && s.pathIndex >= s.path.length - 1) {
      unit.state = { kind: 'idle' };
      return;
    }
  }

  // Smooth facing turn (only when we have meaningful movement).
  if (d > 0.5) {
    const targetAngle = Math.atan2(dy, dx);
    if (unit.facingAngle === undefined) {
      unit.facingAngle = targetAngle;
    } else {
      let diff = targetAngle - unit.facingAngle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      // Turn rate scales with the unit's speed (heavier units turn slower).
      const turnRate = 9; // radians/sec approximation via lerp constant
      unit.facingAngle += diff * Math.min(1, dt * turnRate);
      // Slow movement while turning more than ~45°.
      const turnSlow = 1 - Math.min(0.7, Math.abs(diff) / Math.PI);
      step *= turnSlow;
    }
    if (Math.abs(dx) > 1.5) unit.facing = dx >= 0 ? 1 : -1;
  }

  if (step >= d) {
    unit.pos.x = target.x;
    unit.pos.y = target.y;
    s.pathIndex++;
    s.stuck = 0;
    s.lastDist = undefined;
    if (s.pathIndex >= s.path.length) {
      unit.state = { kind: 'idle' };
    }
    return;
  }
  unit.pos.x += (dx / d) * step;
  unit.pos.y += (dy / d) * step;

  // ----- Stuck detection -----
  // If distance to the next waypoint isn't shrinking (separation push-back,
  // congestion), escalate: re-path once, then give up. Without this, a crowd
  // converging on one spot freezes in `moving` forever.
  if (s.lastDist !== undefined && d >= s.lastDist - step * 0.25) {
    s.stuck = (s.stuck ?? 0) + dt;
  } else {
    s.stuck = 0;
  }
  s.lastDist = d;

  if ((s.stuck ?? 0) > STUCK_GIVE_UP_AFTER) {
    // In a brawl with an attack intent? Swing at whatever is reachable.
    const head = unit.commandQueue?.[0];
    if ((head?.kind === 'attack' || head?.kind === 'attackMove') && (unit.attackDmg ?? 0) > 0) {
      const enemy = findEnemyInRange(unit, deps, 300);
      if (enemy) {
        unit.state = { kind: 'attacking', targetId: enemy.id };
        return;
      }
    }
    unit.state = { kind: 'idle' };
    return;
  }
  if ((s.stuck ?? 0) > STUCK_REPATH_AFTER && deps.now >= (unit.nextRepathAt ?? 0)) {
    unit.nextRepathAt = deps.now + 0.8 + (unit.id % 8) * 0.07;
    const fresh = computePathTo(unit, s.finalTarget, deps);
    if (fresh && fresh.length > 0) {
      unit.state = { kind: 'moving', path: fresh, pathIndex: 0, finalTarget: s.finalTarget, stuck: (s.stuck ?? 0) };
    }
  }
}

function tickGathering(unit: Entity, dt: number, deps: FSMDeps) {
  const s = unit.state as Extract<UnitState, { kind: 'gathering' }>;
  const node = deps.entities.get(s.targetId);
  // Face the resource node while gathering.
  if (node && !node.dead) {
    const dx = node.pos.x - unit.pos.x;
    const dy = node.pos.y - unit.pos.y;
    if (Math.abs(dx) + Math.abs(dy) > 1) {
      unit.facingAngle = Math.atan2(dy, dx);
      unit.facing = dx >= 0 ? 1 : -1;
    }
  }
  if (!node || node.dead || (node.resourceRemaining ?? 0) <= 0) {
    // Resource exhausted: cash out then find a new node.
    if (unit.carrying && unit.carrying.amount > 0) {
      const dropoff = findNearestDropoff(unit, unit.carrying.resource, deps);
      if (dropoff) {
        executeCommand(unit, { kind: 'returnResource', targetId: dropoff.id }, deps);
        return;
      }
    }
    const fresh = node ? findClosestResource(unit, node.typeId, deps) : null;
    if (fresh) {
      executeCommand(unit, { kind: 'gather', targetId: fresh.id }, deps);
    } else {
      unit.state = { kind: 'idle' };
    }
    return;
  }

  // Track the node we're feeding from, so we can resume after dropoff.
  (unit as any)._lastSourceId = node.id;

  const cap = unit.gatherCapacity ?? 10;
  const rate = unit.gatherRate ?? 1;
  if (!unit.carrying || unit.carrying.resource !== node.resourceKind!) {
    unit.carrying = { resource: node.resourceKind!, amount: 0 };
  }
  const want = Math.min(rate * dt, cap - unit.carrying.amount, node.resourceRemaining ?? 0);
  unit.carrying.amount += want;
  node.resourceRemaining = (node.resourceRemaining ?? 0) - want;

  if (node.resourceRemaining <= 0) {
    // Node depleted — free the tile so paths can route through.
    if (node.footprintTiles) deps.world.freeTiles(node.footprintTiles);
    node.dead = true;
    node.deathAt = deps.now;
  }

  if (unit.carrying.amount >= cap - 0.001 || (node.resourceRemaining ?? 0) <= 0) {
    const dropoff = findNearestDropoff(unit, unit.carrying.resource, deps);
    if (dropoff) {
      executeCommand(unit, { kind: 'returnResource', targetId: dropoff.id }, deps);
    } else {
      unit.state = { kind: 'idle' };
    }
  }
}

function tickReturning(unit: Entity, dt: number, deps: FSMDeps) {
  // Reaching the dropoff is handled inside tickIdle's command-queue pop, which
  // fires on arrival at the destination. So while truly walking, we'll be in
  // 'moving' state. This branch is a safety net.
  unit.state = { kind: 'idle' };
}

function tickBuilding(unit: Entity, dt: number, deps: FSMDeps) {
  const s = unit.state as Extract<UnitState, { kind: 'building' }>;
  const target = deps.entities.get(s.targetId);
  if (!target || target.dead || !target.isConstructionSite) {
    unit.state = { kind: 'idle' };
    return;
  }
  if (!isAdjacentToFootprint(worldToTile(unit.pos), target.footprintTiles ?? [])) {
    // Move closer.
    moveTowardEntity(unit, target, deps);
    pushQueue(unit, { kind: 'build', targetId: target.id });
    return;
  }
  // Pour build progress. Each villager contributes its buildSpeed (1.0 base,
  // raised by techs) — so a 12s House takes 12s with one builder, ~6s with two.
  const total = target.buildTime ?? 10;
  const contribution = unit.buildSpeed ?? 1;
  const inc = (dt * contribution) / total;
  target.buildProgress = Math.min(1, (target.buildProgress ?? 0) + inc);
  target.hp = Math.min(
    target.maxHp,
    target.hp + (target.maxHp / total) * dt * contribution,
  );
  if (target.buildProgress >= 1) {
    target.isConstructionSite = false;
    target.hp = target.maxHp;
    deps.onBuildingCompleted(target);
    unit.state = { kind: 'idle' };
  }
}

function tickAttacking(unit: Entity, dt: number, deps: FSMDeps) {
  const s = unit.state as Extract<UnitState, { kind: 'attacking' }>;
  const target = deps.entities.get(s.targetId);
  if (!target || target.dead) {
    unit.state = { kind: 'idle' };
    return;
  }
  // Always face the target while attacking — sprites need this to read.
  {
    const dx = target.pos.x - unit.pos.x;
    const dy = target.pos.y - unit.pos.y;
    if (Math.abs(dx) + Math.abs(dy) > 1) {
      unit.facingAngle = Math.atan2(dy, dx);
      unit.facing = dx >= 0 ? 1 : -1;
    }
  }
  if (!inAttackRange(unit, target)) {
    // Chase — but throttled, so a blocked melee unit doesn't burn A* per tick.
    if (deps.now >= (unit.nextRepathAt ?? 0)) {
      unit.nextRepathAt = deps.now + 0.5 + (unit.id % 8) * 0.06;
      moveTowardEntity(unit, target, deps);
      pushQueue(unit, { kind: 'attack', targetId: target.id });
    }
    return;
  }
  const interval = 1 / (unit.attackSpeed ?? 1);
  if (deps.now - (unit.lastAttackAt ?? -9999) >= interval) {
    unit.lastAttackAt = deps.now;
    // Compute final damage with bonusVs and armor.
    const def = UNIT_DEFS[unit.typeId];
    let dmg = unit.attackDmg ?? 0;
    if (def?.bonusVs && def.bonusVs.typeIds.includes(target.typeId)) {
      dmg += def.bonusVs.dmg;
    }
    // Armor lives on the entity (stamped at spawn; techs mutate it).
    const armor = target.armor ?? UNIT_DEFS[target.typeId]?.armor ?? 0;
    dmg = Math.max(1, dmg - armor);
    target.hp -= dmg;
    // Projectile color: archers use brown arrows, others gold flash.
    const projColor = def?.ranged ? '#c9a06a' : (unit.owner === 1 ? '#f0c850' : '#d04040');
    deps.onProjectile?.(unit.pos, target.pos, projColor);
    deps.onHit?.(target, dmg);
    if (target.hp <= 0) {
      target.dead = true;
      target.deathAt = deps.now;
      if (target.footprintTiles) deps.world.freeTiles(target.footprintTiles);
      deps.onUnitDied(target);
      unit.state = { kind: 'idle' };
    }
  }
}

/** Nearest hostile BUILDING (walls included) within `range` px. Used as the
 *  anti-wall fallback when an attack-move target is unreachable. Gaia units
 *  never siege, and gaia structures are never targets. */
function findNearestEnemyBuilding(unit: Entity, deps: FSMDeps, range: number): Entity | null {
  if (unit.owner === 0) return null;
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const e of deps.entities.values()) {
    if (e.dead || e.kind !== 'building') continue;
    if (e.owner === unit.owner || e.owner === 0) continue;
    const d = dist(unit.pos, e.pos);
    if (d <= range && d < bestD) { best = e; bestD = d; }
  }
  return best;
}

function findEnemyInRange(unit: Entity, deps: FSMDeps, range: number): Entity | null {
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const e of deps.entities.values()) {
    if (e.dead) continue;
    if (e.owner === unit.owner || e.owner === 0) continue;
    const d = dist(unit.pos, e.pos);
    if (d <= range && d < bestD) { best = e; bestD = d; }
  }
  return best;
}

function findNearestDropoff(unit: Entity, resource: ResourceKind, deps: FSMDeps): Entity | null {
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const e of deps.entities.values()) {
    if (e.dead || e.kind !== 'building') continue;
    if (e.owner !== unit.owner) continue;
    if (e.isConstructionSite) continue;
    if (!e.isDropoff) continue;
    if (e.acceptedResources && !e.acceptedResources.includes(resource)) continue;
    const d = dist(unit.pos, e.pos);
    if (d < bestD) { best = e; bestD = d; }
  }
  return best;
}

function isAdjacentToFootprint(pos: TilePos, footprint: TilePos[]): boolean {
  for (const t of footprint) {
    const dx = Math.abs(t.tx - pos.tx);
    const dy = Math.abs(t.ty - pos.ty);
    if (dx <= 1 && dy <= 1) return true;
  }
  return false;
}

// Smallest distance from a point to a building's tile footprint (pixel-space).
// For circular targets (units, no footprint), falls back to center-to-center.
function distToTarget(unit: Entity, target: Entity): number {
  if (!target.footprintTiles || target.footprintTiles.length === 0 || !target.tilePos || !target.sizeTiles) {
    return dist(unit.pos, target.pos) - target.radius;
  }
  const minX = target.tilePos.tx * TILE_SIZE;
  const maxX = (target.tilePos.tx + target.sizeTiles.w) * TILE_SIZE;
  const minY = target.tilePos.ty * TILE_SIZE;
  const maxY = (target.tilePos.ty + target.sizeTiles.h) * TILE_SIZE;
  const cx = Math.max(minX, Math.min(unit.pos.x, maxX));
  const cy = Math.max(minY, Math.min(unit.pos.y, maxY));
  return Math.hypot(unit.pos.x - cx, unit.pos.y - cy);
}

export function inAttackRange(unit: Entity, target: Entity): boolean {
  const range = unit.attackRange ?? 0;
  return distToTarget(unit, target) <= range + 2 + unit.radius * 0.5; // small slack
}
