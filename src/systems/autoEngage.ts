// Auto-engage: idle military units pick up nearby threats. Villagers don't,
// unless explicitly attacking — they flee instead (TODO future).
//
// This is what makes a base feel "alive" in AoE: stationed troops fire on
// raiders. Without it, the game devolves into babysitting each unit.

import { UNIT_DEFS } from '@/config/units';
import type { Entity } from '@/core/types';
import { dist } from '@/util/math';

const AUTO_ENGAGE_RADIUS = 200; // sight range for idle troops

interface AutoEngageDeps {
  now: number;
  entities: Map<number, Entity>;
  issueAttack: (unit: Entity, targetId: number) => void;
}

export function tickAutoEngage(deps: AutoEngageDeps) {
  for (const u of deps.entities.values()) {
    if (u.kind !== 'unit' || u.dead) continue;
    if (u.typeId === 'villager' || u.typeId === 'villager_enemy') continue;
    if (!u.state || u.state.kind !== 'idle') continue;
    const def = UNIT_DEFS[u.typeId];
    if (!def?.attackDmg) continue;
    // Range: use sight (auto-engage radius), then close to attack range.
    let best: Entity | null = null;
    let bestD = Infinity;
    for (const o of deps.entities.values()) {
      if (o.dead) continue;
      if (o.owner === u.owner || o.owner === 0) continue;
      if (o.kind === 'resource') continue;
      const d = dist(u.pos, o.pos);
      if (d <= AUTO_ENGAGE_RADIUS && d < bestD) { best = o; bestD = d; }
    }
    if (best) deps.issueAttack(u, best.id);
  }
}
