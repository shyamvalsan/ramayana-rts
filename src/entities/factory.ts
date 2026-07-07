// Entity constructors. These produce raw Entity objects; ownership of the
// id sequence belongs to the Game singleton, which calls these helpers.

import { TILE_SIZE } from '@/config/constants';
import { BUILDING_DEFS } from '@/config/buildings';
import { RESOURCE_DEFS } from '@/config/resources';
import { UNIT_DEFS } from '@/config/units';
import type { Entity, EntityId, PlayerId, TilePos, Vec2 } from '@/core/types';

export function makeUnit(
  id: EntityId,
  typeId: string,
  owner: PlayerId,
  pos: Vec2,
): Entity {
  const def = UNIT_DEFS[typeId];
  if (!def) throw new Error(`Unknown unit type: ${typeId}`);
  return {
    id,
    kind: 'unit',
    typeId,
    owner,
    pos: { ...pos },
    radius: def.radius,
    hp: def.hp,
    maxHp: def.hp,
    speed: def.speed,
    attackDmg: def.attackDmg,
    attackRange: def.attackRange,
    attackSpeed: def.attackSpeed,
    armor: def.armor,
    gatherRate: def.gatherRate,
    gatherCapacity: def.gatherCapacity,
    state: { kind: 'idle' },
    commandQueue: [],
    lastAttackAt: -9999,
    selectable: true,
  };
}

export function makeBuilding(
  id: EntityId,
  typeId: string,
  owner: PlayerId,
  tile: TilePos,
  construction: boolean,
): Entity {
  const def = BUILDING_DEFS[typeId];
  if (!def) throw new Error(`Unknown building type: ${typeId}`);
  const tiles: TilePos[] = [];
  for (let y = 0; y < def.sizeTiles.h; y++) {
    for (let x = 0; x < def.sizeTiles.w; x++) {
      tiles.push({ tx: tile.tx + x, ty: tile.ty + y });
    }
  }
  const center: Vec2 = {
    x: (tile.tx + def.sizeTiles.w / 2) * TILE_SIZE,
    y: (tile.ty + def.sizeTiles.h / 2) * TILE_SIZE,
  };
  return {
    id,
    kind: 'building',
    typeId,
    owner,
    pos: center,
    radius: Math.max(def.sizeTiles.w, def.sizeTiles.h) * TILE_SIZE * 0.5,
    hp: construction ? 1 : def.hp,
    maxHp: def.hp,
    tilePos: tile,
    sizeTiles: def.sizeTiles,
    footprintTiles: tiles,
    isConstructionSite: construction,
    buildProgress: construction ? 0 : 1,
    buildTime: def.buildTime,
    // Defensive buildings get their combat stats stamped on the entity so
    // per-player techs can buff them without mutating the shared def.
    attackDmg: def.attack?.dmg,
    attackRange: def.attack?.range,
    attackSpeed: def.attack?.rate,
    productionQueue: [],
    rallyPoint: undefined,
    providesPop: def.providesPop,
    isDropoff: def.isDropoff,
    acceptedResources: def.acceptedResources,
    selectable: true,
  };
}

export function makeResourceNode(
  id: EntityId,
  typeId: string,
  tile: TilePos,
): Entity {
  const def = RESOURCE_DEFS[typeId];
  if (!def) throw new Error(`Unknown resource type: ${typeId}`);
  const tiles: TilePos[] = [];
  for (let y = 0; y < def.sizeTiles.h; y++) {
    for (let x = 0; x < def.sizeTiles.w; x++) {
      tiles.push({ tx: tile.tx + x, ty: tile.ty + y });
    }
  }
  const center: Vec2 = {
    x: (tile.tx + def.sizeTiles.w / 2) * TILE_SIZE,
    y: (tile.ty + def.sizeTiles.h / 2) * TILE_SIZE,
  };
  return {
    id,
    kind: 'resource',
    typeId,
    owner: 0,
    pos: center,
    radius: Math.max(def.sizeTiles.w, def.sizeTiles.h) * TILE_SIZE * 0.45,
    hp: def.amount,
    maxHp: def.amount,
    tilePos: tile,
    sizeTiles: def.sizeTiles,
    footprintTiles: tiles,
    resourceKind: def.resource,
    resourceRemaining: def.amount,
    selectable: true,
  };
}
