// Ambient wildlife systems.
//
//   * Deer: gaia units (owner=0) that wander slowly. When killed they reward
//     food to the killer's owner via game.notify + a credit. They flee briefly
//     when damaged.
//   * Birds: a purely visual flock that flies across the visible region every
//     ~20-40 seconds. No collision, no gameplay impact. Rendered as a
//     sprite-image flock entry in game.birds[].

import type { Entity, PlayerId, Vec2 } from '@/core/types';
import type { World } from '@/core/world';
import { MAP_TILES_X, MAP_TILES_Y, TILE_SIZE } from '@/config/constants';
import type { Rng } from '@/util/rng';

/** A single bird in flight. Multiple birds spawn per "event" with small
 *  per-bird offsets so a flock visually moves as a loose group rather than
 *  one stamped image. Each bird also wobbles independently. */
export interface BirdFlock {
  pos: Vec2;
  velX: number;
  velY: number;
  baseVelX: number;     // baseline velocity to wobble around
  baseVelY: number;
  scale: number;        // ~0.6-1.1 for size variation
  flapPhase: number;    // for subtle vertical bob
  /** Phase for slow heading wobble so the bird drifts on its own arc. */
  wobblePhase: number;
  /** Sprite key: 'topdown-bird-1' | '-2' | '-3' — pick at spawn for variety. */
  spriteKey: string;
  life: number;
  maxLife: number;
}

export interface WildlifeDeps {
  now: number;
  dt: number;
  rng: Rng;
  entities: Map<number, Entity>;
  world: World;
  resources: Record<PlayerId, Record<string, number>>;
  notify: (msg: string) => void;
  birds: BirdFlock[];
  // Track which deer have been awarded so we don't double-credit.
  awardedDeerIds: Set<number>;
}

// Each deer keeps a slow wander direction; the FSM doesn't drive them.
// We piggy-back state on the entity itself via untyped fields.
export function tickWildlife(deps: WildlifeDeps) {
  for (const e of deps.entities.values()) {
    if (e.typeId !== 'deer') continue;
    if (e.dead) {
      // Award food on first detection of a dead deer. Credit the owner of the
      // nearest unit — but only within plausible kill distance, so a stray
      // enemy passing far away can't steal (or gift) the bounty.
      if (!deps.awardedDeerIds.has(e.id)) {
        deps.awardedDeerIds.add(e.id);
        let owner: PlayerId | 0 = 0;
        let bestD = 250 * 250;
        for (const o of deps.entities.values()) {
          if (o.dead || o.kind !== 'unit') continue;
          if (o.owner === 0 || !deps.resources[o.owner]) continue;
          const dx = o.pos.x - e.pos.x, dy = o.pos.y - e.pos.y;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; owner = o.owner; }
        }
        if (owner !== 0 && deps.resources[owner]) {
          deps.resources[owner].food = (deps.resources[owner].food ?? 0) + 60;
          if (owner === 1) deps.notify('+60 food from a slain deer.');
        }
      }
      continue;
    }
    wanderDeer(e, deps);
  }
  // Tick birds. Each bird wobbles its own heading sinusoidally so the flock
  // doesn't move as a rigid block — birds drift in and out of formation
  // naturally.
  for (const b of deps.birds) {
    b.wobblePhase += deps.dt * 0.8;
    b.flapPhase += deps.dt * (5 + Math.sin(b.wobblePhase * 1.7) * 1.5);
    // Heading wobble: small lateral oscillation perpendicular to baseline.
    const baseMag = Math.hypot(b.baseVelX, b.baseVelY) || 1;
    const px = -b.baseVelY / baseMag;
    const py = b.baseVelX / baseMag;
    const wobble = Math.sin(b.wobblePhase) * 18;
    b.velX = b.baseVelX + px * wobble;
    b.velY = b.baseVelY + py * wobble;
    b.pos.x += b.velX * deps.dt;
    b.pos.y += b.velY * deps.dt;
    b.life -= deps.dt;
  }
  for (let i = deps.birds.length - 1; i >= 0; i--) {
    const b = deps.birds[i];
    if (b.life <= 0) deps.birds.splice(i, 1);
  }
}

// Per-deer ephemeral state is stashed on the entity via untyped fields:
//   _wvx, _wvy           — current drift velocity (px/sec)
//   _wanderUntil         — sim time when we re-pick a heading
//   _grazeUntil          — sim time until which we stand still grazing
//   _alarmedUntil        — sim time until which we keep fleeing fast
// All start undefined and are filled lazily.
function wanderDeer(e: Entity, deps: WildlifeDeps) {
  const any = e as any;
  const speed = e.speed ?? 40;

  // ----- 1. Detect threats and accumulate flee vector -----
  let fleeX = 0, fleeY = 0, threats = 0;
  let closestThreatDist = Infinity;
  for (const o of deps.entities.values()) {
    if (o.dead || o.kind !== 'unit') continue;
    if (o.owner === 0) continue;
    const dx = e.pos.x - o.pos.x, dy = e.pos.y - o.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < 150 * 150) {
      const d = Math.sqrt(d2) || 1;
      // Closer = stronger flee weight.
      const weight = 1 - Math.min(1, d / 150);
      fleeX += (dx / d) * weight;
      fleeY += (dy / d) * weight;
      threats++;
      if (d < closestThreatDist) closestThreatDist = d;
    }
  }
  // Set/extend alarm timer when threatened so the deer keeps running for a beat
  // after the threat moves away.
  if (threats > 0) {
    any._alarmedUntil = deps.now + 2.5;
    any._grazeUntil = 0;
  }
  const alarmed = (any._alarmedUntil ?? 0) > deps.now;

  // ----- 2. Herd cohesion: drift toward the centroid of nearby deer -----
  let herdX = 0, herdY = 0, mates = 0;
  let alignX = 0, alignY = 0;
  for (const o of deps.entities.values()) {
    if (o.typeId !== 'deer' || o.id === e.id || o.dead) continue;
    const dx = o.pos.x - e.pos.x, dy = o.pos.y - e.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < 200 * 200) {
      herdX += o.pos.x;
      herdY += o.pos.y;
      const oa = o as any;
      alignX += oa._wvx ?? 0;
      alignY += oa._wvy ?? 0;
      mates++;
    }
  }

  // ----- 3. Forest-seeking when alarmed: bias toward nearest tree cluster -----
  let coverX = 0, coverY = 0;
  if (alarmed) {
    let bestD = Infinity;
    let bestTree: Entity | null = null;
    for (const o of deps.entities.values()) {
      if (o.kind !== 'resource' || o.typeId !== 'tree' || o.dead) continue;
      const dx = o.pos.x - e.pos.x, dy = o.pos.y - e.pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD) { bestD = d2; bestTree = o; }
    }
    if (bestTree) {
      const dx = bestTree.pos.x - e.pos.x, dy = bestTree.pos.y - e.pos.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      coverX = dx / d;
      coverY = dy / d;
    }
  }

  // ----- 4. Grazing / wander state machine -----
  if (!alarmed) {
    if ((any._grazeUntil ?? 0) > deps.now) {
      // Stand still grazing.
      any._wvx = 0; any._wvy = 0;
    } else if (any._wanderUntil === undefined || deps.now > any._wanderUntil) {
      // Pick a new heading — slight bias toward herd centroid if any.
      let baseAngle = deps.rng() * Math.PI * 2;
      if (mates > 0) {
        const cx = herdX / mates, cy = herdY / mates;
        const toCentroid = Math.atan2(cy - e.pos.y, cx - e.pos.x);
        // Mix random + toCentroid (lean ~30% toward herd center).
        baseAngle = baseAngle * 0.7 + toCentroid * 0.3;
      }
      const wanderSpeed = speed * (0.25 + deps.rng() * 0.15);
      any._wvx = Math.cos(baseAngle) * wanderSpeed;
      any._wvy = Math.sin(baseAngle) * wanderSpeed;
      any._wanderUntil = deps.now + 2 + deps.rng() * 3;
      // 30% chance to chain a graze after this wander beat.
      if (deps.rng() < 0.30) any._grazeUntil = any._wanderUntil + 2 + deps.rng() * 4;
    }
  }

  // ----- 5. Compose final velocity -----
  let vx = 0, vy = 0;
  if (alarmed && threats > 0) {
    // Strong flee + forest cover bias. Capped at ~90 px/s so heroes (Rama=95,
    // Lakshmana=110) can run them down with arrows — villagers can't.
    const sp = Math.min(95, speed * 1.05);
    vx = ((fleeX * 0.7) + (coverX * 0.4)) * sp;
    vy = ((fleeY * 0.7) + (coverY * 0.4)) * sp;
  } else if (alarmed) {
    // Threat passed but still spooked — keep moving toward cover.
    const sp = speed * 0.8;
    vx = coverX * sp || (any._wvx ?? 0);
    vy = coverY * sp || (any._wvy ?? 0);
  } else {
    vx = any._wvx ?? 0;
    vy = any._wvy ?? 0;
    // Light alignment with nearby deer (boids-style).
    if (mates > 0) {
      vx = vx * 0.85 + (alignX / mates) * 0.15;
      vy = vy * 0.85 + (alignY / mates) * 0.15;
    }
  }

  // Update facing when there's meaningful movement.
  if (Math.abs(vx) + Math.abs(vy) > 1) {
    e.facingAngle = Math.atan2(vy, vx);
    e.facing = vx >= 0 ? 1 : -1;
  }

  // ----- 6. Integrate position, bounce off map edges and terrain -----
  const margin = 24;
  const W = MAP_TILES_X * TILE_SIZE;
  const H = MAP_TILES_Y * TILE_SIZE;
  let nx = e.pos.x + vx * deps.dt;
  let ny = e.pos.y + vy * deps.dt;
  if (nx < margin) { nx = margin; any._wvx = Math.abs(any._wvx ?? 0); }
  else if (nx > W - margin) { nx = W - margin; any._wvx = -Math.abs(any._wvx ?? 0); }
  if (ny < margin) { ny = margin; any._wvy = Math.abs(any._wvy ?? 0); }
  else if (ny > H - margin) { ny = H - margin; any._wvy = -Math.abs(any._wvy ?? 0); }
  // Never wander into water or through buildings: bounce and re-roll heading
  // next beat instead of ghosting through blockers like the old code did.
  if (deps.world.isPassable(Math.floor(nx / TILE_SIZE), Math.floor(ny / TILE_SIZE))) {
    e.pos.x = nx;
    e.pos.y = ny;
  } else {
    any._wvx = -(any._wvx ?? 0);
    any._wvy = -(any._wvy ?? 0);
    any._wanderUntil = 0; // re-pick a heading on the next beat
  }
}

/** Spawn a flock event — multiple individual birds with staggered positions,
 *  per-bird velocity jitter, and randomized sprite. They look like a loose
 *  group flying together but each moves on its own arc. */
export function spawnBirdFlock(birds: BirdFlock[], rng: Rng) {
  const fromLeft = rng() < 0.5;
  const yBand = 100 + rng() * (MAP_TILES_Y * TILE_SIZE - 200);
  const xStart = fromLeft ? -80 : (MAP_TILES_X * TILE_SIZE) + 80;
  const baseSpeed = 90 + rng() * 70;
  // 4-7 birds per flock event.
  const count = 4 + Math.floor(rng() * 4);
  const dir = fromLeft ? 1 : -1;
  const spriteOptions = ['topdown-bird-1', 'topdown-bird-2', 'topdown-bird-3'];
  // Slight stagger so the lead bird is a tick ahead of the followers.
  for (let i = 0; i < count; i++) {
    const lag = i * 26;           // px behind the leader
    const lateral = (rng() - 0.5) * 70;
    const speedJitter = (rng() - 0.5) * 24;
    const baseVelX = dir * (baseSpeed + speedJitter);
    const baseVelY = (rng() - 0.5) * 22;
    const life = 22 + rng() * 10;
    birds.push({
      pos: { x: xStart - dir * lag, y: yBand + lateral },
      velX: baseVelX,
      velY: baseVelY,
      baseVelX,
      baseVelY,
      scale: 0.55 + rng() * 0.55,
      flapPhase: rng() * Math.PI * 2,
      wobblePhase: rng() * Math.PI * 2,
      spriteKey: spriteOptions[Math.floor(rng() * spriteOptions.length)],
      life,
      maxLife: life,
    });
  }
}
