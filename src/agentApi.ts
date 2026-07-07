// Public JS API for AI agents. Exposed on `window.rts.api`.
//
// Design notes:
//   - Read methods return plain JS values (no live entity references). Agents
//     can inspect snapshots without accidentally mutating game state.
//   - Write methods (issueCommand, build, train) validate inputs and return
//     { ok, error? } so a controller can react to failures.
//   - Headless mode (?headless=1 URL param) disables canvas rendering and
//     accelerates the sim to ~10x real time so an agent can play many
//     games per minute.

import { BUILDING_DEFS, PLAYER_BUILDABLE } from '@/config/buildings';
import { UNIT_DEFS } from '@/config/units';
import type { Game } from '@/core/game';
import type { Command, Entity, PlayerId, ResourceKind, TilePos, Vec2 } from '@/core/types';

export interface AgentApi {
  // ---- Inspection ----
  getState(): GameSnapshot;
  listEntities(filter?: EntityFilter): EntitySnapshot[];
  getEntity(id: number): EntitySnapshot | null;
  getResources(playerId?: PlayerId): { wood: number; food: number; gold: number; stone: number; popUsed: number; popCap: number };

  // ---- Commands ----
  issueCommand(unitId: number, command: Command): { ok: boolean; error?: string };
  build(typeId: string, tile: TilePos, builderIds?: number[]): { ok: boolean; error?: string; siteId?: number };
  train(buildingId: number, unitTypeId: string): { ok: boolean; error?: string };
  /** Cast a hero ability (brahmastra/indrastra) at a world position. */
  castAbility(unitId: number, abilityId: string, target: Vec2): { ok: boolean; error?: string };

  // ---- Helpers ----
  findClosest(from: Vec2, predicate: (e: EntitySnapshot) => boolean): EntitySnapshot | null;
  enemyOf(playerId: PlayerId): PlayerId;
  /** Would this building fit at the tile? (No cost/ownership check.) */
  canPlace(typeId: string, tile: TilePos): boolean;

  // ---- Sim control ----
  pause(): void;
  resume(): void;
  step(dt?: number): void;
  setSpeed(multiplier: number): void;
}

export interface GameSnapshot {
  simTime: number;
  outcome: 'playing' | 'won' | 'lost';
  playerId: PlayerId;
  players: PlayerId[];
}

export interface EntitySnapshot {
  id: number;
  kind: 'unit' | 'building' | 'resource';
  typeId: string;
  owner: PlayerId;
  pos: Vec2;
  hp: number;
  maxHp: number;
  state?: string;
  /** For heroes: sim time each ability was last cast (cooldown math). */
  abilityLastUsed?: Record<string, number>;
  carrying?: { resource: ResourceKind; amount: number };
  resourceRemaining?: number;
  isConstructionSite?: boolean;
  buildProgress?: number;
  productionQueueLength?: number;
}

export interface EntityFilter {
  kind?: 'unit' | 'building' | 'resource';
  typeId?: string;
  owner?: PlayerId;
}

interface GameRunner {
  game: Game;
  setSpeedMultiplier: (m: number) => void;
  setPaused: (p: boolean) => void;
  manualStep: (dt: number) => void;
}

export function createAgentApi(runner: GameRunner): AgentApi {
  return {
    getState(): GameSnapshot {
      return {
        simTime: runner.game.simTime,
        outcome: runner.game.outcome,
        playerId: runner.game.playerId,
        players: Object.keys(runner.game.resources).map(Number),
      };
    },

    listEntities(filter?: EntityFilter): EntitySnapshot[] {
      const out: EntitySnapshot[] = [];
      for (const e of runner.game.entities.values()) {
        if (e.dead) continue;
        if (filter?.kind && e.kind !== filter.kind) continue;
        if (filter?.typeId && e.typeId !== filter.typeId) continue;
        if (filter?.owner !== undefined && e.owner !== filter.owner) continue;
        out.push(snapshot(e));
      }
      return out;
    },

    getEntity(id: number): EntitySnapshot | null {
      const e = runner.game.entities.get(id);
      return e && !e.dead ? snapshot(e) : null;
    },

    getResources(playerId?: PlayerId) {
      const id = playerId ?? runner.game.playerId;
      const bag = runner.game.resources[id];
      if (!bag) {
        return { wood: 0, food: 0, gold: 0, stone: 0, popUsed: 0, popCap: 0 };
      }
      return {
        wood: Math.floor(bag.wood),
        food: Math.floor(bag.food),
        gold: Math.floor(bag.gold),
        stone: Math.floor(bag.stone),
        popUsed: runner.game.popUsed(id),
        popCap: runner.game.popCap(id),
      };
    },

    issueCommand(unitId, command) {
      const u = runner.game.entities.get(unitId);
      if (!u) return { ok: false, error: 'unknown unit' };
      if (u.dead) return { ok: false, error: 'unit is dead' };
      if (u.kind !== 'unit') return { ok: false, error: 'entity is not a unit' };
      if (u.owner !== runner.game.playerId) return { ok: false, error: 'not your unit' };
      runner.game.issueCommand(u, command);
      return { ok: true };
    },

    castAbility(unitId, abilityId, target) {
      const u = runner.game.entities.get(unitId);
      if (!u || u.dead) return { ok: false, error: 'unknown or dead unit' };
      if (u.owner !== runner.game.playerId) return { ok: false, error: 'not your unit' };
      const r = runner.game.castAbility(u, abilityId, target);
      return r.ok ? { ok: true } : { ok: false, error: r.reason };
    },

    build(typeId, tile, builderIds) {
      if (!PLAYER_BUILDABLE.includes(typeId)) {
        return { ok: false, error: `building type ${typeId} not buildable by player` };
      }
      const site = runner.game.tryStartConstruction(typeId, tile);
      if (!site) return { ok: false, error: 'placement failed (occupied, water, or insufficient resources)' };
      if (builderIds && builderIds.length > 0) {
        for (const id of builderIds) {
          const u = runner.game.entities.get(id);
          if (u && u.kind === 'unit') {
            runner.game.issueCommand(u, { kind: 'build', targetId: site.id });
          }
        }
      }
      return { ok: true, siteId: site.id };
    },

    train(buildingId, unitTypeId) {
      const b = runner.game.entities.get(buildingId);
      if (!b) return { ok: false, error: 'unknown building' };
      if (b.kind !== 'building') return { ok: false, error: 'entity is not a building' };
      if (b.owner !== runner.game.playerId) return { ok: false, error: 'not your building' };
      if (b.isConstructionSite) return { ok: false, error: 'building is under construction' };
      const def = BUILDING_DEFS[b.typeId];
      if (!def?.trains?.includes(unitTypeId)) {
        return { ok: false, error: `${def?.name ?? b.typeId} cannot train ${unitTypeId}` };
      }
      const ok = runner.game.enqueueProduction(b, unitTypeId);
      return ok ? { ok: true } : { ok: false, error: 'training failed (cost/pop)' };
    },

    findClosest(from, predicate) {
      let best: EntitySnapshot | null = null;
      let bestD = Infinity;
      for (const e of runner.game.entities.values()) {
        if (e.dead) continue;
        const s = snapshot(e);
        if (!predicate(s)) continue;
        const d = Math.hypot(e.pos.x - from.x, e.pos.y - from.y);
        if (d < bestD) { best = s; bestD = d; }
      }
      return best;
    },

    enemyOf(playerId) {
      return playerId === 1 ? 2 : 1;
    },

    canPlace(typeId, tile) {
      const def = BUILDING_DEFS[typeId];
      if (!def) return false;
      return runner.game.world.canPlace(tile.tx, tile.ty, def.sizeTiles.w, def.sizeTiles.h);
    },

    pause: () => runner.setPaused(true),
    resume: () => runner.setPaused(false),
    step: (dt = 0.05) => runner.manualStep(dt),
    setSpeed: (m) => runner.setSpeedMultiplier(m),
  };
}

function snapshot(e: Entity): EntitySnapshot {
  return {
    id: e.id,
    kind: e.kind,
    typeId: e.typeId,
    owner: e.owner,
    pos: { x: e.pos.x, y: e.pos.y },
    hp: e.hp,
    maxHp: e.maxHp,
    state: e.state?.kind,
    abilityLastUsed: e.abilityLastUsed ? { ...e.abilityLastUsed } : undefined,
    carrying: e.carrying ? { ...e.carrying } : undefined,
    resourceRemaining: e.resourceRemaining,
    isConstructionSite: e.isConstructionSite,
    buildProgress: e.buildProgress,
    productionQueueLength: e.productionQueue?.length,
  };
}
