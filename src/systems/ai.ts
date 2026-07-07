// AI opponent: a goal-driven, stateful economy brain. The same script runs
// every N seconds and re-evaluates what to do based on resources, pop, and
// army composition. Not a true behavior tree — just a prioritized check-list
// inspired by openage's "task" model and 0 A.D.'s petra AI.
//
// Behavior phases (soft, not hard transitions):
//   - Eco boom (0-150s): keep training villagers, balance gathering, build
//     houses to stay un-capped, place at least one camp per resource.
//   - First army (150-300s): build barracks + archery range, train mixed
//     spear/archer cohort, station defensively.
//   - Aggression (config.attackWave.firstAt+): build stable, train cavalry,
//     push the configured attack target with a growing army; reinforce after
//     losses.
//
// The AI is intentionally beatable: economy decisions are simple, attack
// timings are loose, and it doesn't scout or react to player composition.
//
// All faction typeIds and aggression pacing come from AIConfig so missions
// can reuse the same brain for different factions / different targets.

import { BUILDING_DEFS } from '@/config/buildings';
import type { Entity, ResourceKind, TilePos, Vec2 } from '@/core/types';
import { TILE_SIZE } from '@/config/constants';

export interface AIDeps {
  now: number;
  ownerId: number;
  entities: Map<number, Entity>;
  resources: Record<number, Record<ResourceKind, number>>;
  popUsed: (owner: number) => number;
  popCap: (owner: number) => number;
  world: { canPlace: (tx: number, ty: number, w: number, h: number) => boolean; w: number; h: number; isPassable: (tx: number, ty: number) => boolean };
  spawnBuilding: (typeId: string, owner: number, tile: TilePos, construction: boolean) => Entity;
  spendResources: (owner: number, cost: Record<string, number>) => boolean;
  issueGather: (unit: Entity, targetId: number) => void;
  issueBuild: (unit: Entity, targetId: number) => void;
  issueAttackMove: (unit: Entity, pos: Vec2) => void;
  issueAttack: (unit: Entity, targetId: number) => void;
  enqueueProduction: (building: Entity, unitTypeId: string) => boolean;
  notify?: (msg: string) => void;
}

/** Faction + aggression parameters for AIController. Everything the old
 *  hardcoded Lanka brain assumed now lives here so missions can retarget it. */
export interface AIConfig {
  villagerType: string;
  houseType: string;
  camps: { lumber: string; mill: string; mining: string };
  military: { barracks: string; range: string; stable: string };
  trainable: { spear: string; archer: string; cavalry: string };
  /** What the attack waves march on (first match owned by targetOwner). */
  attackTargetTypeIds: string[];
  targetOwner: number;
  /** Stop training villagers beyond this. */
  villagerCap: number;
  /** Seconds. Waves need `4 + sizeRamp * wavesSent` standing military to
   *  muster, so each successive wave is at least sizeRamp units bigger. */
  attackWave: { firstAt: number; interval: number; sizeRamp: number };
}

/** The classic skirmish Lanka brain — preserves the pre-parameterization
 *  behavior exactly (first wave >180s, 60s cadence, 4-unit muster, 18 vills). */
export const DEFAULT_LANKA_CONFIG: AIConfig = {
  villagerType: 'villager_enemy',
  houseType: 'house_enemy',
  camps: { lumber: 'lumber_camp_enemy', mill: 'mill_enemy', mining: 'mining_camp_enemy' },
  military: { barracks: 'barracks_enemy', range: 'archery_range_enemy', stable: 'stable_enemy' },
  trainable: { spear: 'spearman_enemy', archer: 'archer_enemy', cavalry: 'cavalry_enemy' },
  attackTargetTypeIds: ['town_center'],
  targetOwner: 1,
  villagerCap: 18,
  attackWave: { firstAt: 180, interval: 60, sizeRamp: 0 },
};

export class AIController {
  ownerId: number;
  config: AIConfig;
  /** Sim time of the first tick — all schedules are relative to it. Lazily
   *  captured so constructing the AI before the sim starts is safe. */
  startTime = -1;
  lastDecisionAt = 0;
  lastAttackWaveAt = 0;
  wavesSent = 0;
  // Where the AI thinks its base center is (its town center; updated per tick).
  homePos: Vec2 = { x: 0, y: 0 };

  constructor(ownerId: number, config: AIConfig = DEFAULT_LANKA_CONFIG) {
    this.ownerId = ownerId;
    this.config = config;
  }

  tick(deps: AIDeps) {
    // Don't run AI on every frame; decision rate ~2/s is plenty.
    if (deps.now - this.lastDecisionAt < 0.5) return;
    this.lastDecisionAt = deps.now;
    if (this.startTime < 0) this.startTime = deps.now;

    const cfg = this.config;
    const elapsed = deps.now - this.startTime;
    const myUnits = this.myUnits(deps);
    const myBuildings = this.myBuildings(deps);
    const tc = myBuildings.find(b => !b.isConstructionSite && this.trainsVillagers(b));
    if (!tc) {
      // TC destroyed — game is effectively over for AI.
      return;
    }
    this.homePos = tc.pos;

    const villagers = myUnits.filter(u => u.typeId === cfg.villagerType);
    const military = myUnits.filter(u => u.typeId !== cfg.villagerType);
    const popUsed = deps.popUsed(this.ownerId);
    const popCap = deps.popCap(this.ownerId);
    const popPressure = popUsed >= popCap - 1;

    // 1. Train villagers on a ramp (8 → 14 → 18), capped by config.
    const targetVillagers = Math.min(
      cfg.villagerCap,
      elapsed < 60 ? 8 : elapsed < 180 ? 14 : 18,
    );
    if (
      villagers.length < targetVillagers &&
      !popPressure &&
      tc.productionQueue && tc.productionQueue.length < 2
    ) {
      deps.enqueueProduction(tc, cfg.villagerType);
    }

    // 2. Keep houses ahead of pop. Build one at a time and assign an idle
    // villager if the current construction site is unmanned.
    const houseCount = myBuildings.filter(b => b.typeId === cfg.houseType).length;
    const housesUnderConstruction = myBuildings.filter(
      b => b.typeId === cfg.houseType && b.isConstructionSite,
    );
    const maxHouses = elapsed < 180 ? 4 : elapsed < 360 ? 8 : 12;
    if (popUsed >= popCap - 3 && housesUnderConstruction.length === 0 && houseCount < maxHouses) {
      this.tryBuildNear(deps, cfg.houseType);
    } else if (housesUnderConstruction.length > 0) {
      // Make sure SOMEONE is building each in-progress house.
      for (const site of housesUnderConstruction) {
        const hasBuilder = myUnits.some(
          u => u.state?.kind === 'building' &&
               (u.state as any).targetId === site.id,
        );
        if (!hasBuilder) {
          const idle = villagers.find(v => v.state?.kind === 'idle' || v.state?.kind === 'gathering');
          if (idle) deps.issueBuild(idle, site.id);
        }
      }
    }

    // 3. Assign idle villagers to gather. Priority order: food, wood, gold, stone.
    this.assignIdleVillagers(deps, villagers);

    // 4. Once we have a few villagers, start a lumber camp + mill near resources.
    if (villagers.length >= 4) {
      if (!this.hasBuiltOrBuilding(myBuildings, cfg.camps.lumber)) {
        this.tryBuildNearResource(deps, cfg.camps.lumber, 'wood');
      }
      if (!this.hasBuiltOrBuilding(myBuildings, cfg.camps.mill)) {
        this.tryBuildNearResource(deps, cfg.camps.mill, 'food');
      }
    }

    // 5. Once we have ~10 villagers, build a mining camp.
    if (villagers.length >= 8 && !this.hasBuiltOrBuilding(myBuildings, cfg.camps.mining)) {
      this.tryBuildNearResource(deps, cfg.camps.mining, 'gold');
    }

    // 6. Military buildings.
    if (elapsed > 90 && !this.hasBuiltOrBuilding(myBuildings, cfg.military.barracks)) {
      this.tryBuildNear(deps, cfg.military.barracks);
    }
    if (elapsed > 180 && !this.hasBuiltOrBuilding(myBuildings, cfg.military.range)) {
      this.tryBuildNear(deps, cfg.military.range);
    }
    if (elapsed > 280 && !this.hasBuiltOrBuilding(myBuildings, cfg.military.stable)) {
      this.tryBuildNear(deps, cfg.military.stable);
    }

    // 6.5. Make sure every in-progress non-house building has a builder.
    for (const site of myBuildings) {
      if (!site.isConstructionSite) continue;
      const hasBuilder = myUnits.some(
        u => u.state?.kind === 'building' && (u.state as any).targetId === site.id,
      );
      if (!hasBuilder) {
        const idle = villagers.find(v => v.state?.kind === 'idle' || v.state?.kind === 'gathering');
        if (idle) deps.issueBuild(idle, site.id);
      }
    }

    // 7. Train military up to a comfortable army.
    const targetArmy = elapsed < 200 ? 4 : elapsed < 360 ? 10 : 16;
    if (military.length < targetArmy && !popPressure) {
      for (const b of myBuildings) {
        if (b.isConstructionSite || !b.productionQueue || b.productionQueue.length >= 2) continue;
        if (b.typeId === cfg.military.barracks) deps.enqueueProduction(b, cfg.trainable.spear);
        else if (b.typeId === cfg.military.range) deps.enqueueProduction(b, cfg.trainable.archer);
        else if (b.typeId === cfg.military.stable) deps.enqueueProduction(b, cfg.trainable.cavalry);
      }
    }

    // 8. Aggression: send an attack wave, then keep re-issuing the order to
    // any idle military unit so wandering soldiers rejoin the push. Cooldown
    // is between *wave declarations* — individual unit re-orders are continuous.
    const target = this.findAttackTarget(deps);
    if (target) {
      const idleMilitary = military.filter(u => u.state?.kind === 'idle' || u.state?.kind === 'attackMove');
      // Muster size grows by sizeRamp each wave so later waves hit harder.
      const muster = Math.min(16, 4 + cfg.attackWave.sizeRamp * this.wavesSent);
      const shouldWave = elapsed > cfg.attackWave.firstAt
        && military.length >= muster
        && deps.now - this.lastAttackWaveAt > cfg.attackWave.interval;
      if (shouldWave) {
        for (const u of military) deps.issueAttackMove(u, target.pos);
        this.lastAttackWaveAt = deps.now;
        this.wavesSent++;
        deps.notify?.('The rakshasas are attacking!');
      } else if (elapsed > cfg.attackWave.firstAt) {
        // Soft re-issue: idle troops walk back into the push.
        for (const u of idleMilitary) {
          // Only re-issue if they're not near a fight already.
          let nearCombat = false;
          for (const o of deps.entities.values()) {
            if (o.dead || o.owner === u.owner || o.owner === 0) continue;
            const d = Math.hypot(o.pos.x - u.pos.x, o.pos.y - u.pos.y);
            if (d < 200) { nearCombat = true; break; }
          }
          if (!nearCombat) deps.issueAttackMove(u, target.pos);
        }
      }
    }
  }

  /** Does this building's def train our villager type? (Faction-agnostic way
   *  to identify "the town center".) */
  private trainsVillagers(b: Entity): boolean {
    return !!BUILDING_DEFS[b.typeId]?.trains?.includes(this.config.villagerType);
  }

  private myUnits(deps: AIDeps): Entity[] {
    return Array.from(deps.entities.values())
      .filter(e => e.kind === 'unit' && e.owner === this.ownerId && !e.dead);
  }

  private hasBuiltOrBuilding(buildings: Entity[], typeId: string): boolean {
    return buildings.some(b => b.typeId === typeId);
  }

  private myBuildings(deps: AIDeps): Entity[] {
    return Array.from(deps.entities.values())
      .filter(e => e.kind === 'building' && e.owner === this.ownerId && !e.dead);
  }

  /** First living building owned by config.targetOwner matching the config's
   *  target list (list order = priority order). */
  private findAttackTarget(deps: AIDeps): Entity | null {
    for (const typeId of this.config.attackTargetTypeIds) {
      for (const e of deps.entities.values()) {
        if (e.kind === 'building' && e.owner === this.config.targetOwner
          && e.typeId === typeId && !e.dead) return e;
      }
    }
    return null;
  }

  private assignIdleVillagers(deps: AIDeps, villagers: Entity[]) {
    const counts: Record<ResourceKind, number> = { wood: 0, food: 0, gold: 0, stone: 0 };
    for (const v of villagers) {
      if (v.state?.kind === 'gathering' || v.state?.kind === 'returning') {
        const r = v.carrying?.resource ?? (v.state.kind === 'gathering' ? v.state.resource : undefined);
        if (r) counts[r]++;
      }
    }
    const total = villagers.length;
    const targets: Record<ResourceKind, number> = {
      food: Math.ceil(total * 0.35),
      wood: Math.ceil(total * 0.35),
      gold: Math.floor(total * 0.20),
      stone: Math.floor(total * 0.10),
    };

    for (const v of villagers) {
      if (v.state?.kind !== 'idle') continue;
      // Assign the most-needed resource that still has a node. Without the
      // fallback, an idle villager whose top-deficit resource is exhausted
      // (e.g. all gold mined out) would stall forever instead of gathering
      // whatever is left.
      const order = (Object.keys(targets) as ResourceKind[])
        .sort((a, b) => (targets[b] - counts[b]) - (targets[a] - counts[a]));
      for (const kind of order) {
        const node = this.findNearestResource(deps, v.pos, kind);
        if (node) {
          deps.issueGather(v, node.id);
          counts[kind]++;
          break;
        }
      }
    }
  }

  private findNearestResource(deps: AIDeps, from: Vec2, kind: ResourceKind): Entity | null {
    let best: Entity | null = null;
    let bestD = Infinity;
    for (const e of deps.entities.values()) {
      if (e.kind !== 'resource' || e.dead) continue;
      if (e.resourceKind !== kind || (e.resourceRemaining ?? 0) <= 0) continue;
      const d = Math.hypot(e.pos.x - from.x, e.pos.y - from.y);
      if (d < bestD) { best = e; bestD = d; }
    }
    return best;
  }

  // Pick a free build site near home; send the closest idle villager.
  private tryBuildNear(deps: AIDeps, typeId: string) {
    const def = BUILDING_DEFS[typeId];
    if (!def) return;
    if (!this.canAfford(deps, def.cost)) return;
    const site = this.findBuildSiteNear(deps, this.homePos, def.sizeTiles.w, def.sizeTiles.h, 8);
    if (!site) return;
    this.placeAndBuild(deps, typeId, site);
  }

  // For dropoff camps: place near a cluster of the appropriate resource.
  private tryBuildNearResource(deps: AIDeps, typeId: string, kind: ResourceKind) {
    const def = BUILDING_DEFS[typeId];
    if (!def) return;
    if (!this.canAfford(deps, def.cost)) return;
    const cluster = this.findResourceCluster(deps, kind);
    if (!cluster) return;
    const site = this.findBuildSiteNear(deps, cluster, def.sizeTiles.w, def.sizeTiles.h, 6);
    if (!site) return;
    this.placeAndBuild(deps, typeId, site);
  }

  private findResourceCluster(deps: AIDeps, kind: ResourceKind): Vec2 | null {
    // Find the closest resource of the right kind to home; cluster center is
    // approximated as its position.
    let best: Entity | null = null;
    let bestD = Infinity;
    for (const e of deps.entities.values()) {
      if (e.kind !== 'resource' || e.dead) continue;
      if (e.resourceKind !== kind || (e.resourceRemaining ?? 0) <= 0) continue;
      const d = Math.hypot(e.pos.x - this.homePos.x, e.pos.y - this.homePos.y);
      if (d < bestD) { best = e; bestD = d; }
    }
    return best ? best.pos : null;
  }

  private findBuildSiteNear(
    deps: AIDeps, center: Vec2, w: number, h: number, maxRadius: number,
  ): TilePos | null {
    const cx = Math.floor(center.x / TILE_SIZE);
    const cy = Math.floor(center.y / TILE_SIZE);
    // Spiral search outward.
    for (let r = 1; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = cx + dx;
          const ty = cy + dy;
          if (deps.world.canPlace(tx, ty, w, h)) return { tx, ty };
        }
      }
    }
    return null;
  }

  private placeAndBuild(deps: AIDeps, typeId: string, site: TilePos) {
    const def = BUILDING_DEFS[typeId];
    const cost: Record<string, number> = {};
    for (const k of Object.keys(def.cost)) cost[k] = (def.cost as any)[k] ?? 0;
    if (!deps.spendResources(this.ownerId, cost)) return;
    const constructionSite = deps.spawnBuilding(typeId, this.ownerId, site, true);
    // Pick a villager to build it.
    const villagers = this.myUnits(deps).filter(u => u.typeId === this.config.villagerType);
    let best: Entity | null = null;
    let bestD = Infinity;
    for (const v of villagers) {
      const d = Math.hypot(v.pos.x - constructionSite.pos.x, v.pos.y - constructionSite.pos.y);
      if (d < bestD) { best = v; bestD = d; }
    }
    if (best) deps.issueBuild(best, constructionSite.id);
  }

  private canAfford(deps: AIDeps, cost: Partial<Record<string, number>>): boolean {
    const bag = deps.resources[this.ownerId];
    for (const k of Object.keys(cost)) {
      const need = (cost as any)[k] ?? 0;
      if ((bag as any)[k] < need) return false;
    }
    return true;
  }
}
