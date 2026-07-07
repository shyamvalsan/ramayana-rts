// Building production queue. A TC trains a Villager: tick its progress while
// the queue head exists, on completion spawn a unit at a free tile adjacent to
// the building and rally it to the rally point if one is set.

import { TILE_SIZE } from '@/config/constants';
import { UNIT_DEFS } from '@/config/units';
import { TECH_DEFS } from '@/config/techs';
import type { Entity, ProductionOrder, ResourceKind, Vec2 } from '@/core/types';
import { World } from '@/core/world';
import { tileCenter } from '@/util/math';

export interface ProductionDeps {
  world: World;
  resources: Record<number, Record<ResourceKind, number>>;
  spawnUnit: (typeId: string, owner: number, pos: Vec2, rally?: Vec2) => Entity;
  notify: (msg: string) => void;
  popUsed: (owner: number) => number;
  popCap: (owner: number) => number;
  /** Tech research support (see Game.researchedTechs / applyTech). */
  hasTech: (owner: number, techId: string) => boolean;
  techInProgress: (owner: number, techId: string) => boolean;
  onTechComplete: (owner: number, techId: string) => void;
}

/** Queue a tech research in a building. Costs are deducted immediately; the
 *  research occupies the same queue units train from. */
export function enqueueResearch(
  building: Entity,
  techId: string,
  deps: ProductionDeps,
): boolean {
  if (building.isConstructionSite) return false;
  if (!building.productionQueue) building.productionQueue = [];
  const tech = TECH_DEFS[techId];
  if (!tech) return false;
  if (!tech.hostBuildings.includes(building.typeId)) return false;
  if (deps.hasTech(building.owner, techId)) return false;
  // Already researching — anywhere (a second host building) — not just here.
  if (deps.techInProgress(building.owner, techId)) return false;
  for (const r of tech.requires ?? []) {
    if (!deps.hasTech(building.owner, r)) {
      deps.notify(`Requires ${TECH_DEFS[r]?.name ?? r}.`);
      return false;
    }
  }
  const bag = deps.resources[building.owner];
  for (const k of Object.keys(tech.cost) as ResourceKind[]) {
    if ((bag[k] ?? 0) < (tech.cost[k] ?? 0)) {
      deps.notify(`Not enough ${k}.`);
      return false;
    }
  }
  for (const k of Object.keys(tech.cost) as ResourceKind[]) {
    bag[k] = (bag[k] ?? 0) - (tech.cost[k] ?? 0);
  }
  building.productionQueue.push({
    kind: 'tech',
    typeId: techId,
    progress: 0,
    buildTime: tech.researchTime,
    cost: tech.cost,
  });
  return true;
}

export function enqueueProduction(
  building: Entity,
  unitTypeId: string,
  deps: ProductionDeps,
): boolean {
  if (building.isConstructionSite) return false;
  if (!building.productionQueue) building.productionQueue = [];
  const def = UNIT_DEFS[unitTypeId];
  if (!def) return false;

  // Check pop cap upfront so player gets clear feedback.
  if (deps.popUsed(building.owner) + def.popCost > deps.popCap(building.owner)) {
    deps.notify('Population cap reached. Build a Kutira.');
    return false;
  }

  // Check resources.
  const bag = deps.resources[building.owner];
  for (const k of Object.keys(def.cost) as ResourceKind[]) {
    const need = def.cost[k] ?? 0;
    if ((bag[k] ?? 0) < need) {
      deps.notify(`Not enough ${k}.`);
      return false;
    }
  }
  // Deduct.
  for (const k of Object.keys(def.cost) as ResourceKind[]) {
    bag[k] = (bag[k] ?? 0) - (def.cost[k] ?? 0);
  }
  building.productionQueue.push({
    typeId: unitTypeId,
    progress: 0,
    buildTime: def.trainTime,
    cost: def.cost,
  });
  return true;
}

export function cancelProduction(building: Entity, index: number, deps: ProductionDeps) {
  if (!building.productionQueue || index >= building.productionQueue.length) return;
  const order = building.productionQueue[index];
  // Refund from the order's own recorded cost (works for units and techs).
  const bag = deps.resources[building.owner];
  for (const k of Object.keys(order.cost) as ResourceKind[]) {
    bag[k] = (bag[k] ?? 0) + (order.cost[k] ?? 0);
  }
  building.productionQueue.splice(index, 1);
}

export function tickBuilding(building: Entity, dt: number, deps: ProductionDeps) {
  if (building.isConstructionSite) return;
  if (!building.productionQueue || building.productionQueue.length === 0) return;
  const head = building.productionQueue[0];
  head.progress += dt / head.buildTime;
  if (head.progress >= 1) {
    if (head.kind === 'tech') {
      deps.onTechComplete(building.owner, head.typeId);
    } else {
      // Spawn at first free adjacent tile.
      const spawnPos = findSpawnTile(building, deps.world);
      deps.spawnUnit(head.typeId, building.owner, spawnPos, building.rallyPoint);
    }
    building.productionQueue.shift();
  }
}

function findSpawnTile(building: Entity, world: World): Vec2 {
  if (!building.tilePos || !building.sizeTiles) return { ...building.pos };
  const tp = building.tilePos;
  const sz = building.sizeTiles;
  // Walk the perimeter clockwise from the bottom-left and take the first passable tile.
  const candidates: { tx: number; ty: number }[] = [];
  for (let x = tp.tx; x < tp.tx + sz.w; x++) candidates.push({ tx: x, ty: tp.ty + sz.h });
  for (let y = tp.ty + sz.h - 1; y >= tp.ty; y--) candidates.push({ tx: tp.tx + sz.w, ty: y });
  for (let x = tp.tx + sz.w - 1; x >= tp.tx; x--) candidates.push({ tx: x, ty: tp.ty - 1 });
  for (let y = tp.ty; y < tp.ty + sz.h; y++) candidates.push({ tx: tp.tx - 1, ty: y });
  for (const c of candidates) {
    if (world.isPassable(c.tx, c.ty)) return tileCenter(c.tx, c.ty);
  }
  // Whole perimeter blocked: search expanding rings around the footprint
  // (radius 2..6 tiles beyond it) for the nearest passable tile, so the unit
  // never spawns inside an impassable tile and gets stranded.
  for (let r = 2; r <= 6; r++) {
    const x0 = tp.tx - r;
    const x1 = tp.tx + sz.w - 1 + r;
    const y0 = tp.ty - r;
    const y1 = tp.ty + sz.h - 1 + r;
    // Top and bottom edges of the ring.
    for (let x = x0; x <= x1; x++) {
      if (world.isPassable(x, y0)) return tileCenter(x, y0);
      if (world.isPassable(x, y1)) return tileCenter(x, y1);
    }
    // Left and right edges (corners already covered above).
    for (let y = y0 + 1; y <= y1 - 1; y++) {
      if (world.isPassable(x0, y)) return tileCenter(x0, y);
      if (world.isPassable(x1, y)) return tileCenter(x1, y);
    }
  }
  // Entire 6-ring failed (map is essentially sealed): last-resort old fallback.
  return { x: building.pos.x, y: building.pos.y + sz.h * TILE_SIZE * 0.5 };
}
