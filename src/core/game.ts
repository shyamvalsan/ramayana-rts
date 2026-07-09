// Central Game state. Owns the entity table, per-player resources, the
// simulation tick, and exposes a tiny API for input/UI to mutate things via
// commands (never by reaching in and editing fields).

import { SIM_DT, STARTING_POP_CAP, STARTING_RESOURCES } from '@/config/constants';
import { BUILDING_DEFS } from '@/config/buildings';
import { UNIT_DEFS } from '@/config/units';
import { ABILITY_DEFS } from '@/config/abilities';
import { World } from '@/core/world';
import type {
  Command,
  Entity,
  EntityId,
  PlayerId,
  ResourceBag,
  ResourceKind,
  TilePos,
  Vec2,
} from '@/core/types';
import { makeBuilding, makeResourceNode, makeUnit } from '@/entities/factory';
import {
  executeCommand,
  tickUnit,
  type FSMDeps,
} from '@/systems/unitFSM';
import {
  enqueueProduction,
  enqueueResearch,
  tickBuilding as tickProduction,
  type ProductionDeps,
} from '@/systems/production';
import { TECH_DEFS, type TechEffect } from '@/config/techs';
import { tickTowers } from '@/systems/towerCombat';
import { tickGates } from '@/systems/gates';
import { tickAutoEngage } from '@/systems/autoEngage';
import { AIController } from '@/systems/ai';
import { Sfx } from '@/audio/audio';
import { FogMap } from '@/core/fog';
import { BirdFlock, spawnBirdFlock, tickWildlife } from '@/systems/wildlife';
import { makeRng, type Rng } from '@/util/rng';
import { MAX_POP_CAP } from '@/config/constants';
import type { MissionDef } from '@/missions/types';

interface ProjectileFX {
  from: Vec2;
  to: Vec2;
  color: string;
  elapsed: number;   // seconds since spawn
  duration: number;  // total flight time (arrows) or visible time (melee flash)
  ranged: boolean;   // true = animated arrow with arc, false = brief tracer flash
}

export interface DeathFX {
  pos: Vec2;
  age: number;
  maxAge: number;
}

export interface FlyingNumberFX {
  pos: Vec2;
  text: string;
  color: string;
  age: number;
  maxAge: number;
  /** Optional offset velocity so multiple numbers don't stack. */
  vx?: number;
  vy?: number;
}

export interface HitFlashFX {
  entityId: number;
  age: number;       // 0..maxAge in seconds
  maxAge: number;
}

/** Anything that can drive a player slot each tick (economy AI, wave
 *  director, scripted mission brain). deps is Game.aiDeps(ownerId). */
export interface EnemyBrain {
  ownerId: number;
  tick(deps: ReturnType<Game['aiDeps']>): void;
}

/** Apply a tech effect's add/mul to a stat value. */
function mod(value: number | undefined, eff: TechEffect): number | undefined {
  if (value === undefined) return undefined;
  let v = value;
  if (eff.mul !== undefined) v *= eff.mul;
  if (eff.add !== undefined) v += eff.add;
  return v;
}

/** Does a tech effect apply to this entity? */
function techEffectMatches(e: Entity, eff: TechEffect): boolean {
  if (eff.targetTypeIds) return eff.targetTypeIds.includes(e.typeId);
  switch (eff.targetClass) {
    case 'villager':
      return e.kind === 'unit' && (UNIT_DEFS[e.typeId]?.gatherRate ?? 0) > 0;
    case 'hero':
      return e.typeId === 'rama' || e.typeId === 'lakshmana';
    case 'military':
      return e.kind === 'unit'
        && (UNIT_DEFS[e.typeId]?.attackDmg ?? 0) > 0
        && !(UNIT_DEFS[e.typeId]?.gatherRate);
    case 'tower':
      return e.kind === 'building' && !!BUILDING_DEFS[e.typeId]?.attack;
    case 'building':
      return e.kind === 'building';
    default:
      return false;
  }
}

/** A beam-style VFX for the Brahmastra / Indrastra. Renders as a glowing
 *  arrow trail from `from` to `to` with `key` selecting the sprite. */
export interface BeamFX {
  from: Vec2;
  to: Vec2;
  key: string;       // 'brahmastra' | 'indrastra'
  age: number;
  maxAge: number;
}

export class Game {
  world = new World();
  entities = new Map<EntityId, Entity>();
  /** Seed for the sim PRNG. All sim-affecting randomness must use `this.rng`
   *  (never Math.random) so a saved game replays consistently. */
  rngSeed: number;
  rng: Rng;
  resources: Record<PlayerId, ResourceBag> = {
    1: { ...STARTING_RESOURCES },
    2: { ...STARTING_RESOURCES },
  };
  popCapBase: Record<PlayerId, number> = { 1: STARTING_POP_CAP, 2: STARTING_POP_CAP };
  selectedIds = new Set<EntityId>();
  playerId: PlayerId = 1;
  simTime = 0;
  nextId: EntityId = 1;
  projectiles: ProjectileFX[] = [];
  deathPuffs: DeathFX[] = [];
  flyingNumbers: FlyingNumberFX[] = [];
  hitFlashes: HitFlashFX[] = [];
  beams: BeamFX[] = [];
  notifications: { text: string; age: number }[] = [];

  // For UI to peek at builder ghost during placement (not for sim logic).
  pendingPlacement: { typeId: string } | null = null;

  // Enemy brains, keyed by player id. Duck-typed: anything with tick(deps)
  // works — the economy AIController, mission WaveDirectors, hybrids.
  ais: Map<PlayerId, EnemyBrain> = new Map();

  // Per-player fog of war. Only the human player's fog drives rendering.
  fog = new FogMap();
  private nextFogRecomputeAt = 0;
  private nextRegenAt = 0;
  fogEnabled = true;

  // Wildlife: ambient bird flocks (purely visual) and deer-kill bookkeeping.
  birds: BirdFlock[] = [];
  awardedDeerIds = new Set<number>();
  private nextBirdAt = 6;

  // Wave-warning flash: when set, the renderer pulses a red vignette + alert
  // banner across the screen for `duration` seconds.
  waveAlert: { text: string; age: number; duration: number } | null = null;

  // Camera-shake amplitude in pixels — decays each frame. Renderer offsets
  // the world transform by a jittered amount proportional to this.
  cameraShake = 0;

  // Tataka boss-fight tracking. Once Tataka has appeared we keep a reference
  // even after she dies so the UI can show "Tataka defeated" briefly.
  bossPhase: 1 | 2 = 1;
  bossEnragedAt = 0;

  // Game-over flag — set when win/lose conditions are met.
  outcome: 'playing' | 'won' | 'lost' = 'playing';
  outcomeAt = 0;

  // When true, wave directors freeze their schedule (no enemy spawns). Used to
  // give new players a calm sandbox during the tutorial — the sim still runs
  // (deer wander, heroes can practice) but no rakshasas attack until the
  // briefing is dismissed.
  waveHold = false;

  // Persistent record that the boss has ever existed — the entity itself is
  // reaped ~1s after death, so win checks must NOT rescan entities for her.
  tatakaEverSpawned = false;

  // The active mission owns win/lose rules and scripted beats. Mission-scoped
  // scratch state (timers, flags for story beats) lives in missionState so a
  // fresh Game always starts clean.
  mission: MissionDef | null = null;
  missionState: Record<string, unknown> = {};

  // Researched techs per player. Effects are stamped onto entities (live ones
  // at research time, future ones at spawn) — defs are never mutated because
  // both factions share them.
  researchedTechs: Record<PlayerId, Set<string>> = { 1: new Set(), 2: new Set() };

  constructor(rngSeed: number = (Date.now() >>> 0)) {
    this.rngSeed = rngSeed;
    this.rng = makeRng(rngSeed);
  }

  spawnUnit = (typeId: string, owner: PlayerId, pos: Vec2, rally?: Vec2): Entity => {
    const e = makeUnit(this.nextId++, typeId, owner, pos);
    this.applyOwnerTechs(e);
    this.entities.set(e.id, e);
    if (typeId === 'tataka') this.tatakaEverSpawned = true;
    if (rally) this.issueCommand(e, { kind: 'move', pos: rally });
    return e;
  };

  /** The one true kill path: marks dead, frees tiles, fires death FX/bookkeeping.
   *  Everything that reduces hp to <= 0 must route through here (or replicate
   *  ALL of it, as unitFSM/towerCombat historically do). */
  killEntity(e: Entity) {
    if (e.dead) return;
    e.dead = true;
    e.deathAt = this.simTime;
    if (e.footprintTiles) this.world.freeTiles(e.footprintTiles);
    this.handleDeath(e);
  }

  spawnBuilding = (typeId: string, owner: PlayerId, tile: TilePos, construction: boolean): Entity => {
    const e = makeBuilding(this.nextId++, typeId, owner, tile, construction);
    this.applyOwnerTechs(e);
    this.entities.set(e.id, e);
    if (e.footprintTiles) this.world.occupyTiles(e.footprintTiles, e.id);
    return e;
  };

  // ---- Tech research ----

  hasTech(owner: PlayerId, techId: string): boolean {
    return this.researchedTechs[owner]?.has(techId) ?? false;
  }

  /** Is this tech already researching in some building's queue for this owner?
   *  Guards against queuing the same blessing at two host buildings at once. */
  techInProgress(owner: PlayerId, techId: string): boolean {
    for (const e of this.entities.values()) {
      if (e.kind !== 'building' || e.owner !== owner || e.dead) continue;
      if (e.productionQueue?.some(o => o.kind === 'tech' && o.typeId === techId)) return true;
    }
    return false;
  }

  enqueueResearch(building: Entity, techId: string): boolean {
    return enqueueResearch(building, techId, this.productionDeps());
  }

  /** Research completed: record it, stamp every matching live entity, notify.
   *  Idempotent — a tech already researched is never applied twice (defends
   *  against two host buildings both completing it, or a stale re-queue). */
  private completeTech(owner: PlayerId, techId: string) {
    const tech = TECH_DEFS[techId];
    if (!tech) return;
    if (this.researchedTechs[owner]?.has(techId)) return;
    (this.researchedTechs[owner] ??= new Set()).add(techId);
    for (const e of this.entities.values()) {
      if (e.owner !== owner || e.dead) continue;
      this.applyTechToEntity(e, techId);
    }
    tech.onComplete?.(this, owner);
    if (owner === this.playerId) {
      this.notify(`${tech.name} — the blessing takes hold.`);
      Sfx.buildComplete();
    }
  }

  /** Stamp all of the owner's researched techs onto a fresh entity. */
  private applyOwnerTechs(e: Entity) {
    const techs = this.researchedTechs[e.owner];
    if (!techs) return;
    for (const id of techs) this.applyTechToEntity(e, id);
  }

  private applyTechToEntity(e: Entity, techId: string) {
    const tech = TECH_DEFS[techId];
    if (!tech) return;
    for (const eff of tech.effects) {
      if (!techEffectMatches(e, eff)) continue;
      switch (eff.stat) {
        case 'attackDmg': e.attackDmg = mod(e.attackDmg, eff); break;
        case 'armor': e.armor = mod(e.armor ?? 0, eff); break;
        case 'speed': e.speed = mod(e.speed, eff); break;
        case 'gatherRate': e.gatherRate = mod(e.gatherRate, eff); break;
        case 'buildSpeed': e.buildSpeed = mod(e.buildSpeed ?? 1, eff); break;
        case 'attackRange': e.attackRange = mod(e.attackRange, eff); break;
        case 'maxHp': {
          const before = e.maxHp;
          e.maxHp = Math.round(mod(e.maxHp, eff) ?? e.maxHp);
          e.hp += Math.max(0, e.maxHp - before); // heal by the gained amount
          break;
        }
      }
    }
  }

  spawnResourceNode = (typeId: string, tile: TilePos): Entity => {
    const e = makeResourceNode(this.nextId++, typeId, tile);
    this.entities.set(e.id, e);
    if (e.footprintTiles) this.world.occupyTiles(e.footprintTiles, e.id);
    return e;
  };

  // ---- Player API ----

  notify(text: string) {
    this.notifications.push({ text, age: 0 });
    if (this.notifications.length > 4) this.notifications.shift();
  }

  /** Trigger the dramatic wave-warning banner + red vignette. */
  alertWave(text: string, duration = 2.4) {
    this.waveAlert = { text, age: 0, duration };
    Sfx.warning();
  }

  /** Add to the camera-shake amplitude. Caps at 18px. */
  addShake(amount: number) {
    this.cameraShake = Math.min(18, this.cameraShake + amount);
  }

  popUsed(owner: PlayerId): number {
    let n = 0;
    for (const e of this.entities.values()) {
      if (e.kind === 'unit' && e.owner === owner && !e.dead) {
        const def = UNIT_DEFS[e.typeId];
        n += def?.popCost ?? 1;
      }
    }
    // In-flight production also counts to prevent overshoot (techs don't).
    for (const e of this.entities.values()) {
      if (e.kind !== 'building' || e.owner !== owner || e.isConstructionSite || e.dead) continue;
      for (const o of e.productionQueue ?? []) {
        if (o.kind === 'tech') continue;
        const d = UNIT_DEFS[o.typeId];
        n += d?.popCost ?? 1;
      }
    }
    return n;
  }

  popCap(owner: PlayerId): number {
    let cap = this.popCapBase[owner] ?? STARTING_POP_CAP;
    for (const e of this.entities.values()) {
      if (e.kind !== 'building' || e.owner !== owner || e.dead) continue;
      if (e.isConstructionSite) continue;
      if (e.providesPop) cap += e.providesPop;
    }
    return Math.min(cap, MAX_POP_CAP);
  }

  byOwner(owner: PlayerId): Entity[] {
    const out: Entity[] = [];
    for (const e of this.entities.values()) if (e.owner === owner && !e.dead) out.push(e);
    return out;
  }

  // Control groups (Ctrl+1..9). Lives on Game so restart clears them.
  controlGroups: Record<number, EntityId[]> = {};

  issueCommand(unit: Entity, cmd: Command, opts?: { queue?: boolean }) {
    // Shift-queued commands append to the END of the queue and run after the
    // current task; a plain command replaces everything (player override).
    if (opts?.queue && unit.state && unit.state.kind !== 'idle') {
      if (!unit.commandQueue) unit.commandQueue = [];
      unit.commandQueue.push(cmd);
      if (unit.commandQueue.length > 8) unit.commandQueue.length = 8;
      return;
    }
    if (!opts?.queue) unit.commandQueue = [];
    const deps = this.fsmDeps();
    executeCommand(unit, cmd, deps);
  }

  // Try to start construction at the given tile. Spends resources up front and
  // immediately spawns a "construction site" entity that any villager can
  // contribute build progress to.
  tryStartConstruction(typeId: string, tile: TilePos, silent = false): Entity | null {
    const def = BUILDING_DEFS[typeId];
    if (!def) return null;
    if (!this.world.canPlace(tile.tx, tile.ty, def.sizeTiles.w, def.sizeTiles.h)) {
      if (!silent) this.notify('Cannot place there.');
      return null;
    }
    const bag = this.resources[this.playerId];
    for (const k of Object.keys(def.cost) as ResourceKind[]) {
      if ((bag[k] ?? 0) < (def.cost[k] ?? 0)) {
        if (!silent) this.notify(`Not enough ${k}.`);
        return null;
      }
    }
    for (const k of Object.keys(def.cost) as ResourceKind[]) {
      bag[k] = (bag[k] ?? 0) - (def.cost[k] ?? 0);
    }
    return this.spawnBuilding(typeId, this.playerId, tile, true);
  }

  enqueueProduction(building: Entity, unitTypeId: string): boolean {
    return enqueueProduction(building, unitTypeId, this.productionDeps());
  }

  // ---- Simulation tick ----

  /** Death FX + bookkeeping. Kill sites either call killEntity (preferred) or
   *  set dead/deathAt + free tiles themselves and then call this. */
  private handleDeath(e: Entity) {
    // Bigger death effect for bosses (per def.bossTier).
    const tier = UNIT_DEFS[e.typeId]?.bossTier;
    const maxAge = tier === 'major' ? 1.6 : tier === 'mid' ? 0.9 : 0.5;
    this.deathPuffs.push({ pos: { ...e.pos }, age: 0, maxAge });
    this.selectedIds.delete(e.id);
    if (e.owner !== 0) Sfx.death();
    if (tier === 'major') {
      this.addShake(16);
      this.alertWave(`${(UNIT_DEFS[e.typeId]?.name ?? e.typeId).toUpperCase()} HAS FALLEN`, 3.2);
      Sfx.victory();
    } else if (tier === 'mid') {
      this.addShake(6);
    }
  }

  private fsmDeps(): FSMDeps {
    return {
      world: this.world,
      now: this.simTime,
      entities: this.entities,
      byOwner: (owner) => this.byOwner(owner),
      resources: this.resources,
      onUnitDied: (e) => this.handleDeath(e),
      onResourceDeposited: (owner, kind, amt, dropoff) => {
        this.resources[owner][kind] = (this.resources[owner][kind] ?? 0) + amt;
        if (owner === this.playerId) {
          Sfx.deposit();
          // Float "+N wood" above the dropoff building.
          const color = kind === 'wood' ? '#c98a3a'
                      : kind === 'food' ? '#e0c060'
                      : kind === 'gold' ? '#f0c850'
                      : '#aab4be';
          const anchor = dropoff?.pos ?? { x: 0, y: 0 };
          this.flyingNumbers.push({
            pos: { x: anchor.x + (this.rng() - 0.5) * 16, y: anchor.y - 20 },
            text: `+${Math.round(amt)} ${kind}`,
            color,
            age: 0,
            maxAge: 1.4,
            vx: 0,
            vy: -28,
          });
        }
      },
      onBuildingCompleted: (e) => {
        this.notify(`${BUILDING_DEFS[e.typeId]?.name ?? 'Building'} complete.`);
        if (e.owner === this.playerId) Sfx.buildComplete();
      },
      onProjectile: (from, to, color) => {
        const ranged = color === '#c9a06a';
        const dist = Math.hypot(to.x - from.x, to.y - from.y);
        const duration = ranged
          ? Math.max(0.14, Math.min(0.55, dist / 580))   // arrows travel ~580 px/s
          : 0.18;
        this.projectiles.push({
          from: { ...from }, to: { ...to }, color, elapsed: 0, duration, ranged,
        });
        if (ranged) Sfx.arrow();
        else Sfx.attack();
      },
      onHit: (target, dmg) => {
        // Damage number floats up + slight horizontal drift so multiple hits
        // don't stack on the exact same pixel.
        this.flyingNumbers.push({
          pos: { x: target.pos.x + (this.rng() - 0.5) * 14, y: target.pos.y - target.radius },
          text: `-${Math.ceil(dmg)}`,
          color: dmg >= 15 ? '#ffd040' : '#ff6060',
          age: 0,
          maxAge: 0.9,
          vx: (this.rng() - 0.5) * 14,
          vy: -36,
        });
        // Brief hit flash on the target's sprite.
        this.hitFlashes.push({ entityId: target.id, age: 0, maxAge: 0.18 });
      },
    };
  }

  private productionDeps(): ProductionDeps {
    return {
      world: this.world,
      resources: this.resources,
      spawnUnit: this.spawnUnit,
      notify: (m) => this.notify(m),
      popUsed: (o) => this.popUsed(o),
      popCap: (o) => this.popCap(o),
      hasTech: (o, t) => this.hasTech(o, t),
      techInProgress: (o, t) => this.techInProgress(o, t),
      onTechComplete: (o, t) => this.completeTech(o, t),
    };
  }

  tick(dt: number) {
    if (this.outcome !== 'playing') {
      // Sim freezes but effects still age out so the screen looks alive.
      this.tickEffects(dt);
      return;
    }
    this.simTime += dt;

    // Step every unit.
    const fsmDeps = this.fsmDeps();
    for (const e of this.entities.values()) {
      if (e.kind === 'unit') tickUnit(e, dt, fsmDeps);
    }

    // Unit-unit separation: push overlapping units apart so groups don't
    // stack on a single tile. Cheap O(n²) scan — fine for our scale.
    this.applyUnitSeparation(dt);

    // Step production for every building.
    const prodDeps = this.productionDeps();
    for (const e of this.entities.values()) {
      if (e.kind === 'building' && !e.dead) tickProduction(e, dt, prodDeps);
    }

    // Tower combat (defensive buildings shoot).
    tickTowers(dt, {
      now: this.simTime,
      entities: this.entities,
      onProjectile: fsmDeps.onProjectile!,
      onUnitDied: fsmDeps.onUnitDied,
      onHit: fsmDeps.onHit,
      world: this.world,
    });

    // Gates auto-open for their owner and shut against enemies (throttled
    // inside the system).
    tickGates({ now: this.simTime, entities: this.entities, world: this.world });

    // Auto-engage idle military.
    tickAutoEngage({
      now: this.simTime,
      entities: this.entities,
      issueAttack: (u, tid) => this.issueCommand(u, { kind: 'attack', targetId: tid }),
    });

    // Run AI controllers.
    for (const ai of this.ais.values()) {
      ai.tick(this.aiDeps(ai.ownerId));
    }

    // Out-of-combat regeneration (heroes, sages). Throttled to 2 Hz; each
    // pulse applies half a second's worth of healing.
    if (this.simTime >= this.nextRegenAt) {
      this.nextRegenAt = this.simTime + 0.5;
      for (const e of this.entities.values()) {
        if (e.kind !== 'unit' || e.dead || e.hp >= e.maxHp) continue;
        const regen = UNIT_DEFS[e.typeId]?.hpRegen;
        if (!regen) continue;
        let threatened = false;
        for (const o of this.entities.values()) {
          if (o.dead || o.kind !== 'unit' || o.owner === e.owner || o.owner === 0) continue;
          const dx = o.pos.x - e.pos.x, dy = o.pos.y - e.pos.y;
          if (dx * dx + dy * dy < 300 * 300) { threatened = true; break; }
        }
        if (!threatened) e.hp = Math.min(e.maxHp, e.hp + regen * 0.5);
      }
    }

    // Mission script hook (boss phases, story beats, escalation).
    this.mission?.tick?.(this, dt);

    // Camera shake decay.
    this.cameraShake *= Math.pow(0.001, dt); // exponential decay
    if (this.cameraShake < 0.1) this.cameraShake = 0;

    // Fog of war recompute (4 Hz to keep cost low).
    if (this.fogEnabled && this.simTime >= this.nextFogRecomputeAt) {
      this.nextFogRecomputeAt = this.simTime + 0.25;
      this.fog.recompute(this.entities.values(), this.playerId);
    }

    // Wildlife — deer wander, birds drift across.
    tickWildlife({
      now: this.simTime,
      dt,
      rng: this.rng,
      entities: this.entities,
      world: this.world,
      resources: this.resources as any,
      notify: (m) => this.notify(m),
      birds: this.birds,
      awardedDeerIds: this.awardedDeerIds,
    });
    if (this.simTime >= this.nextBirdAt) {
      spawnBirdFlock(this.birds, this.rng);
      this.nextBirdAt = this.simTime + 25 + this.rng() * 20;
    }
    if (this.waveAlert) {
      this.waveAlert.age += dt;
      if (this.waveAlert.age > this.waveAlert.duration) this.waveAlert = null;
    }

    // Win/lose detection.
    this.evaluateOutcome();

    // Age effects.
    for (const p of this.projectiles) p.elapsed += dt;
    this.projectiles = this.projectiles.filter(p => p.elapsed < p.duration);
    for (const d of this.deathPuffs) d.age += dt;
    this.deathPuffs = this.deathPuffs.filter(d => d.age < d.maxAge);
    for (const n of this.flyingNumbers) {
      n.age += dt;
      if (n.vx !== undefined) n.pos.x += n.vx * dt;
      if (n.vy !== undefined) n.pos.y += n.vy * dt;
    }
    this.flyingNumbers = this.flyingNumbers.filter(n => n.age < n.maxAge);
    for (const h of this.hitFlashes) h.age += dt;
    this.hitFlashes = this.hitFlashes.filter(h => h.age < h.maxAge);
    for (const bm of this.beams) bm.age += dt;
    this.beams = this.beams.filter(bm => bm.age < bm.maxAge);
    for (const n of this.notifications) n.age += dt;
    this.notifications = this.notifications.filter(n => n.age < 3);

    // Clean dead entities (after a short delay so renderer can fade them).
    for (const [id, e] of this.entities) {
      if (e.dead && this.simTime - (e.deathAt ?? this.simTime) > 1.0) {
        this.entities.delete(id);
      }
    }
  }

  // Default step uses the project sim rate.
  step() { this.tick(SIM_DT); }

  // Push overlapping units apart so they don't visually stack.
  //
  // Two hard rules, learned from a full-mission deadlock:
  //   1. ENGAGED units (attacking / gathering / building) and seated VIPs hold
  //      their ground — they are never pushed. A brawl ring must stay planted
  //      or melee never lands a hit.
  //   2. A push may not shove a unit into water or a building footprint;
  //      blocked axes are cancelled instead.
  // Movers still yield to each other, but the per-tick cap keeps separation
  // from out-muscling actual movement (speed ~60-110 px/s vs cap 150 px/s
  // only when heavily overlapped).
  private applyUnitSeparation(dt: number) {
    const units: Entity[] = [];
    for (const e of this.entities.values()) {
      if (e.kind === 'unit' && !e.dead) units.push(e);
    }
    const maxPushPerTick = 150 * dt;
    const holdsGround = (u: Entity) => {
      const k = u.state?.kind;
      return k === 'attacking' || k === 'gathering' || k === 'building'
        || u.typeId === 'rishi' || u.typeId === 'vishwamitra';
    };
    for (let i = 0; i < units.length; i++) {
      const a = units[i];
      if (holdsGround(a)) continue;
      let pushX = 0, pushY = 0;
      for (let j = 0; j < units.length; j++) {
        if (i === j) continue;
        const b = units[j];
        const dx = a.pos.x - b.pos.x;
        const dy = a.pos.y - b.pos.y;
        // Personal space — 1.35× combined radii keeps a visible gap between
        // sprites without inflating crowds so far they can't reach targets.
        const minDist = (a.radius + b.radius) * 1.35;
        const d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          const ang = this.rng() * Math.PI * 2;
          pushX += Math.cos(ang) * minDist;
          pushY += Math.sin(ang) * minDist;
          continue;
        }
        if (d2 < minDist * minDist) {
          const d = Math.sqrt(d2);
          const overlap = (minDist - d);
          // Anchored neighbors push hardest (walk around the brawl, don't
          // compress it); fellow movers share the correction.
          const factor = holdsGround(b) ? 1.3 : 0.7;
          pushX += (dx / d) * overlap * factor;
          pushY += (dy / d) * overlap * factor;
        }
      }
      if (pushX === 0 && pushY === 0) continue;
      const mag = Math.hypot(pushX, pushY);
      if (mag > maxPushPerTick) {
        pushX = (pushX / mag) * maxPushPerTick;
        pushY = (pushY / mag) * maxPushPerTick;
      }
      // Respect static blockers: never push into water/buildings. Try the full
      // push, then each axis alone, else stay put.
      const ts = this.world.tileSize;
      const ok = (x: number, y: number) =>
        this.world.isPassable(Math.floor(x / ts), Math.floor(y / ts));
      if (ok(a.pos.x + pushX, a.pos.y + pushY)) {
        a.pos.x += pushX; a.pos.y += pushY;
      } else if (ok(a.pos.x + pushX, a.pos.y)) {
        a.pos.x += pushX;
      } else if (ok(a.pos.x, a.pos.y + pushY)) {
        a.pos.y += pushY;
      }
    }
  }

  private tickEffects(dt: number) {
    for (const p of this.projectiles) p.elapsed += dt;
    this.projectiles = this.projectiles.filter(p => p.elapsed < p.duration);
    for (const d of this.deathPuffs) d.age += dt;
    this.deathPuffs = this.deathPuffs.filter(d => d.age < d.maxAge);
    for (const n of this.flyingNumbers) {
      n.age += dt;
      if (n.vx !== undefined) n.pos.x += n.vx * dt;
      if (n.vy !== undefined) n.pos.y += n.vy * dt;
    }
    this.flyingNumbers = this.flyingNumbers.filter(n => n.age < n.maxAge);
    for (const h of this.hitFlashes) h.age += dt;
    this.hitFlashes = this.hitFlashes.filter(h => h.age < h.maxAge);
    for (const bm of this.beams) bm.age += dt;
    this.beams = this.beams.filter(bm => bm.age < bm.maxAge);
    // Banners/toasts must also age out after the game ends, or the wave-alert
    // vignette from the final kill freezes over the victory screen.
    if (this.waveAlert) {
      this.waveAlert.age += dt;
      if (this.waveAlert.age > this.waveAlert.duration) this.waveAlert = null;
    }
    for (const n of this.notifications) n.age += dt;
    this.notifications = this.notifications.filter(n => n.age < 3);
    this.cameraShake *= Math.pow(0.001, dt);
    if (this.cameraShake < 0.1) this.cameraShake = 0;
  }

  /** Cast a hero ability at a target position (or specific entity). Returns
   *  true if the cast went through, false if on cooldown / insufficient food. */
  castAbility(unit: Entity, abilityId: string, target: Vec2): { ok: boolean; reason?: string } {
    const def = ABILITY_DEFS[abilityId];
    if (!def) return { ok: false, reason: 'unknown ability' };
    if (unit.typeId !== def.ownerTypeId) return { ok: false, reason: 'wrong caster' };
    unit.abilityLastUsed ??= {};
    const last = unit.abilityLastUsed[abilityId] ?? -1e9;
    if (this.simTime - last < def.cooldown) {
      return { ok: false, reason: `${Math.ceil(def.cooldown - (this.simTime - last))}s cooldown` };
    }
    const bag = this.resources[unit.owner];
    if (bag && (bag.food ?? 0) < def.foodCost) return { ok: false, reason: 'not enough food' };
    // Resolve effect. A whiff (e.g. Indrastra with no target near the mark)
    // costs nothing — no cooldown, no food.
    let fired = true;
    if (abilityId === 'brahmastra') {
      fired = this.fireBrahmastra(unit, target);
    } else if (abilityId === 'indrastra') {
      fired = this.fireIndrastra(unit, target);
    }
    if (!fired) return { ok: false, reason: 'no target near the mark' };
    if (bag) bag.food -= def.foodCost;
    unit.abilityLastUsed[abilityId] = this.simTime;
    return { ok: true };
  }

  private fireBrahmastra(caster: Entity, target: Vec2): boolean {
    // Aim along caster→target, extend the line to ability range. Damage every
    // enemy entity within `lineWidth` of the segment.
    const def = ABILITY_DEFS.brahmastra;
    const dx = target.x - caster.pos.x;
    const dy = target.y - caster.pos.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return false;
    const ux = dx / dist, uy = dy / dist;
    const end = { x: caster.pos.x + ux * def.range, y: caster.pos.y + uy * def.range };
    const lineWidth = 36;
    let firstTargetX = end.x, firstTargetY = end.y;
    // Sort potential targets by distance along the line so we can clip the
    // beam at the *furthest* enemy hit (visual feel).
    const hits: Entity[] = [];
    for (const e of this.entities.values()) {
      if (e.dead) continue;
      if (e.owner === caster.owner || e.owner === 0) continue;
      // Project onto line.
      const rx = e.pos.x - caster.pos.x;
      const ry = e.pos.y - caster.pos.y;
      const along = rx * ux + ry * uy;
      if (along < 0 || along > def.range) continue;
      const perp = Math.abs(rx * uy - ry * ux);
      if (perp > lineWidth + e.radius) continue;
      hits.push(e);
    }
    // Apply damage to all hits.
    const dmg = def.damage;
    for (const e of hits) {
      e.hp -= dmg;
      this.fsmDeps().onHit?.(e, dmg);
      if (e.hp <= 0) this.killEntity(e);
    }
    // Clamp the beam end to the last hit (or full range if none).
    if (hits.length > 0) {
      let furthest = 0;
      for (const e of hits) {
        const rx = e.pos.x - caster.pos.x;
        const ry = e.pos.y - caster.pos.y;
        const along = rx * ux + ry * uy;
        if (along > furthest) furthest = along;
      }
      firstTargetX = caster.pos.x + ux * (furthest + 30);
      firstTargetY = caster.pos.y + uy * (furthest + 30);
    }
    this.beams.push({
      from: { ...caster.pos },
      to: { x: firstTargetX, y: firstTargetY },
      key: 'brahmastra',
      age: 0,
      maxAge: 0.6,
    });
    this.addShake(6);
    this.notify('Rama unleashes the Brahmastra!');
    Sfx.victory(); // brief celestial sound
    return true;
  }

  private fireIndrastra(caster: Entity, target: Vec2): boolean {
    const def = ABILITY_DEFS.indrastra;
    // The bolt lands where the caster can actually reach: clamp the aim point
    // to the ability's cast range, then strike the closest enemy near it.
    const aimDx = target.x - caster.pos.x, aimDy = target.y - caster.pos.y;
    const aimD = Math.hypot(aimDx, aimDy);
    const aim = aimD > def.range
      ? { x: caster.pos.x + (aimDx / aimD) * def.range, y: caster.pos.y + (aimDy / aimD) * def.range }
      : target;
    const SNAP_RADIUS = 120; // how far from the mark the bolt will seek
    let best: Entity | null = null;
    let bestD = Infinity;
    for (const e of this.entities.values()) {
      if (e.dead) continue;
      if (e.owner === caster.owner || e.owner === 0) continue;
      const dx = e.pos.x - aim.x, dy = e.pos.y - aim.y;
      const d = Math.hypot(dx, dy);
      if (d <= SNAP_RADIUS && d < bestD) { best = e; bestD = d; }
    }
    if (!best) return false;
    const dmg = def.damage;
    best.hp -= dmg;
    this.fsmDeps().onHit?.(best, dmg);
    // Real stun: the FSM freezes this unit until the timer expires.
    best.state = { kind: 'idle' };
    best.commandQueue = [];
    best.stunnedUntil = this.simTime + 1.6;
    if (best.hp <= 0) this.killEntity(best);
    this.beams.push({
      from: { ...caster.pos },
      to: { ...best.pos },
      key: 'indrastra',
      age: 0,
      maxAge: 0.5,
    });
    this.addShake(3);
    this.notify('Lakshmana looses the Indrastra!');
    return true;
  }

  private aiDeps(aiOwner: PlayerId) {
    return {
      now: this.simTime,
      rng: this.rng,
      waveHold: this.waveHold,
      ownerId: aiOwner,
      entities: this.entities,
      resources: this.resources,
      popUsed: (o: PlayerId) => this.popUsed(o),
      popCap: (o: PlayerId) => this.popCap(o),
      world: this.world,
      spawnUnit: this.spawnUnit,
      spawnBuilding: this.spawnBuilding,
      spendResources: (owner: PlayerId, cost: Record<string, number>) => {
        const bag = this.resources[owner];
        for (const k of Object.keys(cost)) {
          if ((bag as any)[k] < cost[k]) return false;
        }
        for (const k of Object.keys(cost)) {
          (bag as any)[k] -= cost[k];
        }
        return true;
      },
      issueGather: (u: Entity, tid: number) => this.issueCommand(u, { kind: 'gather', targetId: tid }),
      issueBuild: (u: Entity, tid: number) => this.issueCommand(u, { kind: 'build', targetId: tid }),
      issueAttackMove: (u: Entity, pos: { x: number; y: number }) => this.issueCommand(u, { kind: 'attackMove', pos }),
      issueAttack: (u: Entity, tid: number) => this.issueCommand(u, { kind: 'attack', targetId: tid }),
      enqueueProduction: (b: Entity, t: string) => this.enqueueProduction(b, t),
      notify: (m: string) => this.notify(m),
      alertWave: (m: string, d?: number) => this.alertWave(m, d),
      addShake: (n: number) => this.addShake(n),
    };
  }

  private evaluateOutcome() {
    if (!this.mission) return;
    const result = this.mission.evaluateOutcome(this);
    if (result !== 'playing') {
      this.outcome = result;
      this.outcomeAt = this.simTime;
    }
  }
}
