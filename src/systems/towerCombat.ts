// Defensive buildings (watchtowers + town center) auto-fire at enemies in
// range. Simple cooldown-based logic; not an FSM since towers are stateless.

import { BUILDING_DEFS } from '@/config/buildings';
import { UNIT_DEFS } from '@/config/units';
import type { Entity, Vec2 } from '@/core/types';
import { dist } from '@/util/math';

interface TowerDeps {
  now: number;
  entities: Map<number, Entity>;
  onProjectile: (from: Vec2, to: Vec2, color: string) => void;
  onUnitDied: (e: Entity) => void;
  onHit?: (target: Entity, dmg: number) => void;
  world: { freeTiles: (tiles: any[]) => void };
}

export function tickTowers(dt: number, deps: TowerDeps) {
  for (const e of deps.entities.values()) {
    if (e.kind !== 'building' || e.dead || e.isConstructionSite) continue;
    const def = BUILDING_DEFS[e.typeId];
    if (!def?.attack) continue;
    // Combat stats live on the entity (stamped at spawn) so per-player techs
    // can buff them; the def is only a fallback.
    const rate = e.attackSpeed ?? def.attack.rate;
    const range = e.attackRange ?? def.attack.range;
    const atk = e.attackDmg ?? def.attack.dmg;
    const interval = 1 / rate;
    if (deps.now - (e.lastAttackAt ?? -9999) < interval) continue;
    // Find nearest hostile.
    let best: Entity | null = null;
    let bestD = Infinity;
    for (const o of deps.entities.values()) {
      if (o.dead || o.owner === 0 || o.owner === e.owner) continue;
      if (o.kind !== 'unit') continue;
      const d = dist(e.pos, o.pos);
      if (d <= range && d < bestD) { best = o; bestD = d; }
    }
    if (!best) continue;
    e.lastAttackAt = deps.now;
    const tgtDef = UNIT_DEFS[best.typeId];
    let dmg = atk - (best.armor ?? tgtDef?.armor ?? 0);
    if (dmg < 1) dmg = 1;
    best.hp -= dmg;
    deps.onProjectile(e.pos, best.pos, '#f0c850');
    deps.onHit?.(best, dmg);
    if (best.hp <= 0 && !best.dead) {
      best.dead = true;
      best.deathAt = deps.now;
      deps.onUnitDied(best);
    }
  }
}
