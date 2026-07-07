// Snapshot save/load. Serializes a Game into a JSON-safe plain object and
// reconstructs a playable Game from it. This is a SNAPSHOT save, not a
// replay: we capture the current sim state (entities, world, rng position,
// brain progress) and resume from there.
//
// What is intentionally NOT saved (restarts empty/default on load):
//   - FX arrays: projectiles, deathPuffs, flyingNumbers, hitFlashes, beams.
//   - notifications, waveAlert, cameraShake — transient presentation.
//   - birds (ambient wildlife visuals) — a fresh flock drifts in after load.
//   - pendingPlacement — UI-only builder-ghost state.
//   - fogEnabled — a user setting; main.ts re-applies it from the settings
//     panel, so persisting it here would fight the user's preference.
//   - world.blocker — derived state; rebuilt from restored entities'
//     footprintTiles (dead entities freed their tiles when they died).
//
// Corpse policy: dead entities inside their ~1s corpse window ARE saved
// (with deathAt) and restored. Keeping them (a) preserves entity-map
// insertion order exactly, so a save→load→save round trip is stable, and
// (b) keeps awardedDeerIds consistent — dropping a dead deer while its id
// sits in awardedDeerIds would be harmless, but dropping the corpse while
// FORGETTING awardedDeerIds would double-award food. Both are saved.
//
// missionState contract: Game.missionState must remain JSON-safe (plain
// objects, arrays, numbers, strings, booleans, null — no functions, class
// instances, Maps/Sets, or entity references). Missions that stash entity
// handles must store ids instead.

import { Game } from '@/core/game';
import type { Entity, PlayerId, ResourceBag } from '@/core/types';
import type { MissionDef } from '@/missions/types';

export const SAVE_VERSION = 1;

const KEY_PREFIX = 'rts-save-';
const META_KEY = 'rts-save-meta';

/** JSON-safe clone of one entity: ALL own enumerable properties, including
 *  untyped expando fields systems stash on entities (deer wander state etc.). */
export type SavedEntity = Entity & Record<string, unknown>;

export interface SavedBrain {
  owner: PlayerId;
  /** Shallow bag of the brain's serializable own props — see captureBrainState. */
  state: Record<string, unknown>;
}

export interface SaveData {
  version: number;
  missionId: string;
  simTime: number;
  nextId: number;
  rngSeed: number;
  rngState: number;
  playerId: PlayerId;
  resources: Record<PlayerId, ResourceBag>;
  popCapBase: Record<PlayerId, number>;
  outcome: 'playing' | 'won' | 'lost';
  outcomeAt: number;
  bossPhase: 1 | 2;
  bossEnragedAt: number;
  tatakaEverSpawned: boolean;
  /** Mission-owned scratch state. MUST be JSON-safe (see header comment). */
  missionState: Record<string, unknown>;
  /** Researched blessings per player (Set → array). Without this, a load
   *  empties the tech record while stamped entity stats persist — desyncing
   *  the HUD and enabling a re-research double-buff. */
  researchedTechs: Record<PlayerId, string[]>;
  selectedIds: number[];
  /** Control groups (Ctrl+1..9), ids per slot. */
  controlGroups: Record<number, number[]>;
  awardedDeerIds: number[];
  /** World tile arrays, plain number arrays (Uint8Array round trip). */
  terrain: number[];
  variation: number[];
  /** FogMap.vis (Uint8Array round trip). */
  fogVis: number[];
  /** Entities in Map iteration (== insertion) order. Order matters: blocker
   *  re-occupation and "first entity wins" scans depend on it. */
  entities: SavedEntity[];
  /** Per-owner enemy-brain resumable state (wave index, timers, ...). */
  brains: SavedBrain[];
  /** Private Game throttle timers, restored best-effort so loading does not
   *  fire an immediate regen pulse / bird spawn (the latter draws on the sim
   *  rng). Optional: absent or stale values only cause cosmetic hiccups. */
  timers?: {
    nextFogRecomputeAt?: number;
    nextRegenAt?: number;
    nextBirdAt?: number;
  };
}

export interface SaveSlotInfo {
  slot: string;
  missionId: string;
  simTime: number;
  savedAt: number;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

// ±Infinity is not representable in JSON (becomes null), but some sentinels
// rely on it — e.g. an entity's `nextOrderAt = Infinity` means "an AI brain
// must never re-order this unit" (Aranya's routed/scripted units). Round-trip
// them through string markers so the sentinel survives a save.
const POS_INF = '__Infinity__';
const NEG_INF = '__-Infinity__';
function infReplacer(_k: string, v: unknown) {
  if (v === Infinity) return POS_INF;
  if (v === -Infinity) return NEG_INF;
  return v;
}
function infReviver(_k: string, v: unknown) {
  if (v === POS_INF) return Infinity;
  if (v === NEG_INF) return -Infinity;
  return v;
}

/** Deep JSON-safe clone. Drops functions and undefined-valued keys, and
 *  preserves ±Infinity sentinels. */
function jsonClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, infReplacer), infReviver) as T;
}

function isPrimitive(v: unknown): v is number | string | boolean | null {
  return v === null || (typeof v !== 'object' && typeof v !== 'function');
}

/** Plain object (Object.prototype / null proto) whose own enumerable values
 *  are all primitives — e.g. WaveDirector.homePos {x, y}. */
function isFlatPrimitiveObject(v: unknown): v is Record<string, number | string | boolean | null> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(v).every(isPrimitive);
}

/** Known brain CONFIG objects that mission.load rebuilds — never saved. */
const BRAIN_SKIP_KEYS = new Set(['waves', 'bossShake']);

/** Capture a brain's resumable state: own enumerable props that are
 *  primitives, arrays of primitives, or flat primitive objects (homePos).
 *  Excluded: functions, BRAIN_SKIP_KEYS config, and object references such
 *  as AIController.attackTargetTC (an Entity handle — dropped; the AI simply
 *  re-acquires a target after load). */
function captureBrainState(brain: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(brain)) {
    if (BRAIN_SKIP_KEYS.has(k)) continue;
    if (typeof v === 'function') continue;
    if (isPrimitive(v)) {
      out[k] = v;
    } else if (Array.isArray(v) && v.every(isPrimitive)) {
      out[k] = v.slice();
    } else if (isFlatPrimitiveObject(v)) {
      out[k] = { ...v };
    }
    // Anything else (entity refs, nested config) is intentionally dropped.
  }
  return out;
}

export function serializeGame(game: Game): SaveData {
  const entities: SavedEntity[] = [];
  for (const e of game.entities.values()) {
    // Clone ALL own enumerable props (typed fields AND expandos).
    entities.push(jsonClone(e as SavedEntity));
  }

  const brains: SavedBrain[] = [];
  for (const [owner, brain] of game.ais) {
    brains.push({ owner, state: captureBrainState(brain) });
  }

  // Private throttle timers — read via any-cast; TS privacy is compile-time
  // only. If a field is renamed these come back undefined and JSON drops
  // them, which the loader tolerates.
  const g = game as unknown as Record<string, unknown>;

  return {
    version: SAVE_VERSION,
    missionId: game.mission!.id,
    simTime: game.simTime,
    nextId: game.nextId,
    rngSeed: game.rngSeed,
    rngState: game.rng.getState(),
    playerId: game.playerId,
    resources: jsonClone(game.resources),
    popCapBase: jsonClone(game.popCapBase),
    outcome: game.outcome,
    outcomeAt: game.outcomeAt,
    bossPhase: game.bossPhase,
    bossEnragedAt: game.bossEnragedAt,
    tatakaEverSpawned: game.tatakaEverSpawned,
    missionState: jsonClone(game.missionState),
    researchedTechs: {
      1: Array.from(game.researchedTechs[1] ?? []),
      2: Array.from(game.researchedTechs[2] ?? []),
    },
    selectedIds: Array.from(game.selectedIds),
    controlGroups: jsonClone(game.controlGroups),
    awardedDeerIds: Array.from(game.awardedDeerIds),
    terrain: Array.from(game.world.terrain),
    variation: Array.from(game.world.variation),
    fogVis: Array.from(game.fog.vis),
    entities,
    brains,
    timers: {
      nextFogRecomputeAt: g.nextFogRecomputeAt as number | undefined,
      nextRegenAt: g.nextRegenAt as number | undefined,
      nextBirdAt: g.nextBirdAt as number | undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Deserialization
// ---------------------------------------------------------------------------

/** Copy a saved number[] into a typed array, tolerating a length mismatch
 *  (e.g. map-size constants changed between builds). */
function copyInto(dst: Uint8Array | Int32Array, src: number[]) {
  const n = Math.min(dst.length, src.length);
  for (let i = 0; i < n; i++) dst[i] = src[i];
  if (dst.length !== src.length) {
    console.warn(`[save] tile-array length mismatch (saved ${src.length}, world ${dst.length}) — map constants changed?`);
  }
}

/**
 * Rebuild a playable Game from a SaveData snapshot. `mission` must be the
 * MissionDef whose id equals data.missionId (the caller resolves it via the
 * mission registry).
 *
 * Limitation: brains are rebuilt by running mission.load on a throwaway
 * scratch Game and transplanting the brains it installs. Missions that add
 * brains dynamically mid-game (none currently do) would lose those brains.
 */
export function deserializeGame(data: SaveData, mission: MissionDef): Game {
  // a. Fresh game with the original seed; jump the rng to the saved position.
  const game = new Game(data.rngSeed);
  game.rng.setState(data.rngState);
  game.mission = mission;
  game.playerId = data.playerId ?? 1;

  // b. Rebuild enemy brains without polluting the real game: mission.load on
  // a scratch Game constructs the brains (with their non-serializable config
  // — waves, bossShake — from source), then we transplant them and overlay
  // the saved resumable state. Brains hold no reference to their Game (they
  // receive deps per tick), so transplanting is safe. The scratch and its
  // entities/world are discarded.
  const scratch = new Game(data.rngSeed);
  mission.load(scratch);
  for (const [owner, brain] of scratch.ais) {
    const saved = data.brains.find(b => b.owner === owner);
    if (saved) Object.assign(brain, jsonClone(saved.state));
    game.ais.set(owner, brain);
  }

  // c. World: restore terrain + variation; blocker is derived — zero it and
  // re-occupy from restored entity footprints below.
  copyInto(game.world.terrain, data.terrain);
  copyInto(game.world.variation, data.variation);
  game.world.blocker.fill(0);

  // d. Entities: plain-object clones, reinserted in saved (== original
  // insertion) order so Map iteration order — and everything that depends on
  // it (blocker overwrites, "first match wins" scans) — is preserved.
  // Dead entities within their corpse window are restored as-is (deathAt
  // intact) and do NOT re-occupy tiles: killEntity freed them at death.
  for (const raw of data.entities) {
    const e = jsonClone(raw);
    game.entities.set(e.id, e);
    // An OPEN gate freed its tiles while open — it must stay passable on load,
    // or friendly units can no longer path through their own open gate.
    const gateHeldOpen = e.typeId === 'gate' && e.gateOpen === true;
    if (!e.dead && e.footprintTiles && !gateHeldOpen) {
      game.world.occupyTiles(e.footprintTiles, e.id);
    }
  }

  game.nextId = data.nextId;
  game.simTime = data.simTime;
  game.resources = jsonClone(data.resources);
  game.popCapBase = jsonClone(data.popCapBase);
  game.outcome = data.outcome;
  game.outcomeAt = data.outcomeAt;
  game.bossPhase = data.bossPhase;
  game.bossEnragedAt = data.bossEnragedAt;
  game.tatakaEverSpawned = data.tatakaEverSpawned;
  game.missionState = jsonClone(data.missionState);
  // Researched blessings: rebuild the per-player Sets so hasTech() is correct
  // and future spawns get stamped. Entity stats were already restored above,
  // so we do NOT re-apply effects here (that would double-buff).
  game.researchedTechs = {
    1: new Set(data.researchedTechs?.[1] ?? []),
    2: new Set(data.researchedTechs?.[2] ?? []),
  };
  game.selectedIds = new Set(data.selectedIds);
  game.controlGroups = data.controlGroups ? jsonClone(data.controlGroups) : {};
  game.awardedDeerIds = new Set(data.awardedDeerIds);
  copyInto(game.fog.vis, data.fogVis);

  // Best-effort restore of private throttle timers (see SaveData.timers).
  if (data.timers) {
    const g = game as unknown as Record<string, unknown>;
    if (typeof data.timers.nextFogRecomputeAt === 'number') g.nextFogRecomputeAt = data.timers.nextFogRecomputeAt;
    if (typeof data.timers.nextRegenAt === 'number') g.nextRegenAt = data.timers.nextRegenAt;
    if (typeof data.timers.nextBirdAt === 'number') g.nextBirdAt = data.timers.nextBirdAt;
  }

  // NOT restored (see header comment): FX arrays, notifications, waveAlert,
  // cameraShake, birds, pendingPlacement, fogEnabled, world.blocker (rebuilt).
  return game;
}

// ---------------------------------------------------------------------------
// localStorage slots
// ---------------------------------------------------------------------------

type MetaIndex = Record<string, { missionId: string; simTime: number; savedAt: number }>;

function readMeta(): MetaIndex {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as MetaIndex : {};
  } catch {
    return {};
  }
}

/** Serialize `game` into localStorage under `rts-save-<slot>` and record the
 *  slot in the meta index. Never throws (quota errors etc. are warned). */
export function saveToSlot(game: Game, slot: string): void {
  try {
    const data = serializeGame(game);
    localStorage.setItem(KEY_PREFIX + slot, JSON.stringify(data, infReplacer));
    const meta = readMeta();
    meta[slot] = { missionId: data.missionId, simTime: data.simTime, savedAt: Date.now() };
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch (err) {
    console.warn(`[save] failed to save slot "${slot}":`, err);
  }
}

/** Read a slot back. Returns null (with a console.warn) on a missing slot,
 *  parse failure, or version mismatch. Never throws. */
export function loadFromSlot(slot: string): SaveData | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + slot);
    if (!raw) return null;
    const data = JSON.parse(raw, infReviver) as SaveData;
    if (!data || data.version !== SAVE_VERSION) {
      console.warn(`[save] slot "${slot}" has version ${data?.version}, expected ${SAVE_VERSION} — ignoring.`);
      return null;
    }
    return data;
  } catch (err) {
    console.warn(`[save] failed to load slot "${slot}":`, err);
    return null;
  }
}

/** All known saves, newest first. Slots whose payload key has been removed
 *  from localStorage (cleared externally) are skipped. */
export function listSaves(): SaveSlotInfo[] {
  try {
    const meta = readMeta();
    const out: SaveSlotInfo[] = [];
    for (const [slot, m] of Object.entries(meta)) {
      if (!m || typeof m !== 'object') continue;
      if (localStorage.getItem(KEY_PREFIX + slot) === null) continue;
      out.push({ slot, missionId: m.missionId, simTime: m.simTime, savedAt: m.savedAt });
    }
    out.sort((a, b) => b.savedAt - a.savedAt);
    return out;
  } catch (err) {
    console.warn('[save] failed to list saves:', err);
    return [];
  }
}
