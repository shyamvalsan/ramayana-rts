// Gate logic: gates auto-open for their owner and shut against enemies.
//
// A gate's footprint tiles behave like any building blocker while CLOSED
// (units path around it, enemies must batter it down). When a friendly unit
// approaches and no enemy is near, the gate OPENS: its tiles are freed so
// paths route straight through. The whole system is throttled to ~0.3s —
// gates are the only thing that toggles blocker tiles at runtime, so keep
// the surface small and predictable.
//
// Invariants:
//   * A gate under construction stays closed (spawnBuilding occupied its
//     tiles; we never touch construction sites).
//   * A dead gate is never re-occupied — killEntity already freed its tiles
//     and the corpse only lingers for the render fade.
//   * Closing never clobbers a foreign blocker id: if something else somehow
//     claimed a tile while the gate stood open, that tile is left alone.

import type { Entity, TilePos } from '@/core/types';
import type { World } from '@/core/world';
import { TILE_SIZE } from '@/config/constants';

export interface GateDeps {
  now: number;
  entities: Map<number, Entity>;
  world: World;
}

const GATE_TICK_INTERVAL = 0.3;
const OPEN_RANGE = 2.5 * TILE_SIZE;   // friendly unit this close → wants open
const THREAT_RANGE = 5 * TILE_SIZE;   // enemy unit this close → forces closed

// Per-world throttle timestamp. Keyed on the World instance so a fresh Game
// (restart, mission change) starts with a clean clock instead of inheriting
// the previous run's simTime.
const lastRunAt = new WeakMap<World, number>();

export function tickGates(deps: GateDeps) {
  const last = lastRunAt.get(deps.world);
  if (last !== undefined && deps.now - last < GATE_TICK_INTERVAL) return;
  lastRunAt.set(deps.world, deps.now);

  for (const gate of deps.entities.values()) {
    if (gate.kind !== 'building' || gate.typeId !== 'gate') continue;
    if (gate.dead) continue;                 // tiles already freed by killEntity
    if (gate.isConstructionSite) continue;   // stays occupying (closed)

    // Scan units once: any friendly close enough to open, any enemy close
    // enough to force shut. An enemy sighting decides the outcome outright.
    let friendlyNear = false;
    let enemyNear = false;
    for (const u of deps.entities.values()) {
      if (u.kind !== 'unit' || u.dead || u.owner === 0) continue;
      const dx = u.pos.x - gate.pos.x;
      const dy = u.pos.y - gate.pos.y;
      const d2 = dx * dx + dy * dy;
      if (u.owner === gate.owner) {
        if (d2 <= OPEN_RANGE * OPEN_RANGE) friendlyNear = true;
      } else if (d2 <= THREAT_RANGE * THREAT_RANGE) {
        enemyNear = true;
        break;
      }
    }

    const shouldOpen = friendlyNear && !enemyNear;
    if (shouldOpen === !!gate.gateOpen) continue;
    gate.gateOpen = shouldOpen;
    if (!gate.footprintTiles) continue;
    if (shouldOpen) {
      deps.world.freeTiles(gate.footprintTiles);
    } else {
      // Re-occupy only tiles that are still ours to claim (empty or already
      // stamped with this gate's id) — never overwrite another entity.
      const mine: TilePos[] = [];
      for (const t of gate.footprintTiles) {
        const b = deps.world.blockerAt(t.tx, t.ty);
        if (b === 0 || b === gate.id) mine.push(t);
      }
      deps.world.occupyTiles(mine, gate.id);
    }
  }
}
