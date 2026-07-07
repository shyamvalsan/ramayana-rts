// Mission II — Aranya Kanda: "The Hermitage at Panchavati".
//
// The exile years. Rama, Lakshmana, and Sita raise a hermitage beside the
// Godavari; the player builds the settlement's economy, then survives
// Shurpanakha's vengeance: her fourteen rakshasas, Dushana, Trisiras, and
// finally Khara's host in three staggered waves. The Golden Deer is an
// optional bait whose branches both converge on Maricha.
//
// Win:  Khara has fallen AND the field is clear (or his routed host has fled).
// Lose: The Hermitage is destroyed, Rama or Lakshmana dies, or the economy
//       is irrecoverably dead (softlock guard).
//
// Framework law honored throughout: every scripted beat auto-advances via a
// timeout stored in game.missionState — nothing here can gate the win open.

import { MAP_TILES_X, MAP_TILES_Y, MAP_W, TILE_SIZE } from '@/config/constants';
import { BUILDING_DEFS, type BuildingDef } from '@/config/buildings';
import { UNIT_DEFS, type UnitDef } from '@/config/units';
import type { Game } from '@/core/game';
import type { Entity, TilePos, Vec2 } from '@/core/types';
import { tileCenter } from '@/util/math';
import { spawnForest } from '@/missions/balaKanda';
import type { MissionDef, Outcome } from '@/missions/types';
import { WaveDirector, type WaveDef } from '@/missions/waveDirector';

// ============================================================================
// Defs owned by this mission — registered into the shared records at import
// time so the factory/renderer/HUD all see them without engine edits.
// ============================================================================

const ARANYA_UNIT_DEFS: Record<string, UnitDef> = {
  dushana: {
    typeId: 'dushana',
    name: 'Dushana',
    description: "Khara's marshal. Leads the vanguard against Panchavati.",
    hp: 400,
    radius: 13,
    speed: 85,
    attackDmg: 14,
    attackRange: 24,
    attackSpeed: 1.0,
    armor: 2,
    spriteBase: 'grunt_enemy',
    bossTier: 'mid',
    sizeScale: 1.3,
    trainTime: 0,
    cost: {},
    popCost: 0,
    builtAt: [],
    primaryColor: '#7a2a2a',
    accentColor: '#1a0a0a',
    weaponColor: '#1a1a1a',
    ranged: false,
  },
  trisiras: {
    typeId: 'trisiras',
    name: 'Trisiras',
    description: 'The three-headed rider. Fast, and he brings cavalry.',
    hp: 500,
    radius: 12,
    speed: 115,
    attackDmg: 12,
    attackRange: 22,
    attackSpeed: 1.1,
    armor: 1,
    spriteBase: 'grunt_enemy',
    bossTier: 'mid',
    sizeScale: 1.25,
    tintColor: 'rgba(120, 40, 160, 0.35)',
    trainTime: 0,
    cost: {},
    popCost: 0,
    builtAt: [],
    primaryColor: '#6a3080',
    accentColor: '#1a0a1a',
    weaponColor: '#1a1a1a',
    ranged: false,
  },
  khara: {
    typeId: 'khara',
    name: 'Khara',
    description: "Ravana's cousin, lord of Janasthana. Fourteen thousand march behind him.",
    hp: 900,
    radius: 16,
    speed: 80,
    attackDmg: 20,
    attackRange: 26,
    attackSpeed: 0.9,
    armor: 3,
    spriteBase: 'subahu',
    bossTier: 'major',
    sizeScale: 1.45,
    trainTime: 0,
    cost: {},
    popCost: 0,
    builtAt: [],
    primaryColor: '#4a2018',
    accentColor: '#0a0a0a',
    weaponColor: '#1a1a1a',
    ranged: false,
  },
  golden_deer: {
    typeId: 'golden_deer',
    name: 'Golden Deer',
    description: "A deer of living gold — too beautiful to be true. Maricha's favorite shape.",
    hp: 60,
    radius: 11,
    speed: 105,
    armor: 0,
    spriteBase: 'deer',
    tintColor: 'rgba(255, 200, 40, 0.45)',
    trainTime: 0,
    cost: {},
    popCost: 0,
    builtAt: [],
    primaryColor: '#e8c050',
    accentColor: '#f0e0c0',
    weaponColor: '#000000',
    ranged: false,
  },
};
Object.assign(UNIT_DEFS, ARANYA_UNIT_DEFS);

const ARANYA_BUILDING_DEFS: Record<string, BuildingDef> = {
  hermitage: {
    typeId: 'hermitage',
    name: 'The Hermitage',
    themedName: 'Panchavati',
    description:
      "Sita's cottage of leaves and river-clay beneath the five banyans. "
      + 'Trains villagers and accepts every resource. If it falls, the exile falls with it.',
    sizeTiles: { w: 2, h: 2 },
    hp: 1200,
    cost: {},
    buildTime: 0,
    isDropoff: true,
    acceptedResources: ['wood', 'food', 'gold', 'stone'],
    providesPop: 10,
    trains: ['villager'],
    sightRange: 9,
    spriteBase: 'house',
    primaryColor: '#c2a36e',
    roofColor: '#8a5a3a',
    accentColor: '#f0c850',
  },
};
Object.assign(BUILDING_DEFS, ARANYA_BUILDING_DEFS);

// ============================================================================
// Tuning knobs
// ============================================================================

const WAVE_SCALE = 1;
/** Beat times share the director's single balance knob. */
const T = (s: number) => s * WAVE_SCALE;

const HERMITAGE_TILE: TilePos = { tx: 40, ty: 46 };

// The Godavari band along the south, with one sandy ford.
const WATER_TOP = 55;
const WATER_BOTTOM = 58;
const FORD_X0 = 30;
const FORD_X1 = 35;

// The NW clearing the golden deer haunts.
const DEER_HOME: TilePos = { tx: 12, ty: 10 };

const SHURPANAKHA_AT = 150;   // walk-in begins
const SHURPANAKHA_TIMEOUT = 60;   // approach auto-cuts after this long
const SHURPANAKHA_ROUT_DESPAWN = 20; // rout despawn timeout
const DEER_AT = 700;
const FINALE_AT = 810;        // deer branch converges here (first host wave)
const KHARA_AT = 850;         // Khara himself, middle host wave
const ROUT_CLEANUP = 45;      // stragglers vanish this long after the rout

const WAVES: WaveDef[] = [
  {
    at: 270,
    units: [{ typeId: 'grunt_enemy', count: 14 }],
    edges: [2],
    warning: 'Her fourteen rakshasas howl for vengeance!',
  },
  {
    at: 450,
    units: [
      { typeId: 'dushana', count: 1 },
      { typeId: 'spearman_enemy', count: 6 },
      { typeId: 'archer_enemy', count: 4 },
    ],
    edges: [0],
    warning: "Dushana's vanguard marches!",
  },
  {
    at: 630,
    units: [
      { typeId: 'trisiras', count: 1 },
      { typeId: 'archer_enemy', count: 5 },
      { typeId: 'cavalry_enemy', count: 4 },
    ],
    edges: [0, 3],
    warning: 'Trisiras rides with the cavalry!',
  },
  {
    at: FINALE_AT,
    units: [
      { typeId: 'grunt_enemy', count: 5 },
      { typeId: 'spearman_enemy', count: 3 },
      { typeId: 'archer_enemy', count: 2 },
    ],
    edges: [2],
    warning: "Khara's host descends — the vanguard strikes!",
  },
  {
    at: KHARA_AT,
    units: [
      { typeId: 'khara', count: 1 },
      { typeId: 'grunt_enemy', count: 4 },
      { typeId: 'spearman_enemy', count: 3 },
      { typeId: 'archer_enemy', count: 2 },
    ],
    edges: [0],
    warning: 'KHARA MARCHES WITH FOURTEEN THOUSAND',
    shake: 8,
  },
  {
    at: 890,
    units: [
      { typeId: 'grunt_enemy', count: 4 },
      { typeId: 'cavalry_enemy', count: 4 },
      { typeId: 'archer_enemy', count: 2 },
    ],
    edges: [3],
    warning: 'The host closes the ring from the east!',
  },
];

// ============================================================================
// Mission-scoped scratch state. Lives in game.missionState so a fresh Game
// (restart) resets every beat. All values are JSON-safe numbers/booleans.
// ============================================================================

interface AranyaState {
  [key: string]: unknown;
  nextThinkAt?: number;
  hermitageId?: number;

  // Shurpanakha walk-in (pure theater; cannot gate anything).
  shurpanakhaPhase?: 'approach' | 'rout' | 'done';
  shurpanakhaId?: number;
  shurpanakhaCutAt?: number;   // approach timeout → flee beat fires anyway
  shurpanakhaGoneAt?: number;  // rout timeout → silent despawn
  shurpanakhaPokeAt?: number;  // next explicit move order

  // Golden Deer (optional bait; both branches converge on Maricha).
  deerPhase?: 'alive' | 'resolved';
  deerId?: number;
  deerWanderAt?: number;
  deerLastX?: number;
  deerLastY?: number;

  // Khara & the rout. kharaSeen persists past corpse reaping.
  kharaSeen?: boolean;
  kharaDead?: boolean;
  routBannerAt?: number;
  routEndAt?: number;
  routFinished?: boolean;
}

const st = (game: Game) => game.missionState as AranyaState;

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, '0')}`;
}

// ============================================================================
// The mission
// ============================================================================

export const aranyaKanda: MissionDef = {
  id: 'aranya-kanda',
  chapter: 'Aranya Kanda',
  title: 'The Hermitage at Panchavati',
  description:
    'Exiled from Ayodhya, Rama, Lakshmana, and Sita raise a hermitage at Panchavati '
    + 'beside the Godavari. Build the settlement and feed the exiles — because when '
    + "Shurpanakha flees disfigured into the trees, Khara and his fourteen thousand "
    + 'will come to burn everything you have made.',
  teaserKey: 'teaser-aranya-kanda',
  requires: ['bala-kanda'],
  heroes: [
    { typeId: 'rama', abilityId: 'brahmastra', hotkey: 'q' },
    { typeId: 'lakshmana', abilityId: 'indrastra', hotkey: 'e' },
  ],
  anchorTypeIds: ['hermitage'],
  showWaveCounter: true,
  economyEnabled: true,
  techIds: ['bala_mantra', 'atibala_mantra', 'sabaris_offering', 'agastyas_armory', 'agneyastra_tips', 'vigil_of_jatayu'],

  load(game: Game) {
    paintTerrain(game);

    // ===== The Hermitage — Sita's cottage, center-south =====
    const herm = game.spawnBuilding('hermitage', 1, { ...HERMITAGE_TILE }, false);
    st(game).hermitageId = herm.id;

    // ===== Rama, Lakshmana, and four villagers beside it =====
    game.spawnUnit('rama',      1, tileCenter(38, 49));
    game.spawnUnit('lakshmana', 1, tileCenter(44, 49));
    game.spawnUnit('villager',  1, tileCenter(39, 45));
    game.spawnUnit('villager',  1, tileCenter(43, 45));
    game.spawnUnit('villager',  1, tileCenter(38, 47));
    game.spawnUnit('villager',  1, tileCenter(43, 48));

    // ===== Food near home: a berry grove and a small herd =====
    const bushes: TilePos[] = [
      { tx: 34, ty: 49 }, { tx: 35, ty: 49 }, { tx: 36, ty: 49 },
      { tx: 34, ty: 50 }, { tx: 35, ty: 50 }, { tx: 36, ty: 50 },
      { tx: 35, ty: 51 },
    ];
    for (const b of bushes) game.spawnResourceNode('berry_bush', b);

    const deerSpots: TilePos[] = [
      { tx: 32, ty: 42 }, { tx: 34, ty: 52 }, { tx: 47, ty: 44 },
      { tx: 46, ty: 52 }, { tx: 37, ty: 40 }, { tx: 44, ty: 41 },
    ];
    for (const s of deerSpots) {
      const d = game.spawnUnit('deer', 0, tileCenter(s.tx, s.ty));
      d.facingAngle = game.rng() * Math.PI * 2;
    }

    // ===== Forests west / north / east, plus a homestead copse =====
    spawnForest(game, 6,  36, 10, 14); // west wall of trees
    spawnForest(game, 26, 3,  12, 8);  // northern woods
    spawnForest(game, 46, 4,  10, 7);  // northern woods, east half
    spawnForest(game, 66, 34, 9,  12); // eastern woods
    spawnForest(game, 50, 49, 7,  5);  // copse by the hermitage for early wood

    // ===== Gold + stone in the NE clearing — deliberately ON the raid lane =====
    game.spawnResourceNode('gold_vein',  { tx: 53, ty: 13 });
    game.spawnResourceNode('gold_vein',  { tx: 55, ty: 12 });
    game.spawnResourceNode('gold_vein',  { tx: 52, ty: 16 });
    game.spawnResourceNode('stone_vein', { tx: 57, ty: 14 });
    game.spawnResourceNode('stone_vein', { tx: 58, ty: 16 });
    game.spawnResourceNode('stone_vein', { tx: 56, ty: 18 });

    // ===== Rakshasa wave director =====
    const director = new WaveDirector({
      ownerId: 2,
      homePos: { ...herm.pos },
      waves: WAVES,
      waveScale: WAVE_SCALE,
      bossShake: { khara: 12, dushana: 6, trisiras: 6, maricha: 6 },
    });
    game.ais.set(2, director);
  },

  tick(game: Game) {
    const ms = st(game);
    const now = game.simTime;
    if (now < (ms.nextThinkAt ?? 0)) return;
    ms.nextThinkAt = now + 0.35; // ~3 Hz — beats don't need tick-rate precision

    tickShurpanakha(game, ms, now);
    tickGoldenDeer(game, ms, now);
    tickKharaRout(game, ms, now);
  },

  evaluateOutcome(game: Game): Outcome {
    const ms = st(game);
    let hermitageAlive = false;
    let ramaAlive = false;
    let lakshmanaAlive = false;
    let enemyUnitsAlive = false;
    for (const e of game.entities.values()) {
      if (e.dead) continue;
      if (e.kind === 'building' && e.owner === 1) {
        if (e.typeId === 'hermitage') hermitageAlive = true;
      } else if (e.kind === 'unit') {
        if (e.typeId === 'rama') ramaAlive = true;
        if (e.typeId === 'lakshmana') lakshmanaAlive = true;
        if (e.owner === 2) enemyUnitsAlive = true;
      }
    }
    if (!hermitageAlive || !ramaAlive || !lakshmanaAlive) return 'lost';
    // No economy-death softlock guard: the two heroes are always a live win
    // path (Khara dies to their arrows), and reaching this line already means
    // both are alive — so a "no villagers / no barracks" state is a setback,
    // never an unwinnable one. A guard here only ever fired false losses.
    // kharaDead is a missionState flag set by tick() — the corpse is reaped
    // ~1s after death, so the win check must never rescan entities for him.
    if (ms.kharaDead && (!enemyUnitsAlive || ms.routFinished)) return 'won';
    return 'playing';
  },

  victoryText(game: Game) {
    return `Khara has fallen. Fourteen thousand rakshasas lie dead or scattered into the Dandaka.<br/><br/>
      But the birds have gone quiet over Panchavati. The cooking fire is cold.
      The hermitage stands empty. A golden chariot vanishes into the northern sky.<br/><br/>
      <b>Sita is gone.</b><br/><br/>
      <span style="color: var(--text-dim)">Aranya Kanda complete in ${formatTime(game.simTime)}.</span>`;
  },

  defeatText(game: Game) {
    return `Smoke rises over Panchavati. The five banyans burn, and the Godavari carries the ashes south.<br/><br/>
      The exile has failed; the forest keeps no refuge for the unprepared.<br/><br/>
      <span style="color: var(--text-dim)">Survived ${formatTime(game.simTime)}. Raise the hermitage again.</span>`;
  },

  helpHtml: `
    <p><b>Objective:</b> build the exile settlement and survive Khara's vengeance.
    The Hermitage, Rama, and Lakshmana must all survive. Kill Khara to break the host.</p>
    <p><b>Economy:</b> train villagers at the Hermitage — it accepts every resource.
    Gather the berry grove and hunt deer for food; the woods on every side hold timber.
    Gold and stone lie in a northeastern clearing <b>directly on the raid lane</b> —
    mine them early or mine them escorted.</p>
    <p><b>Defense:</b> every wave is announced with its direction — intercept ahead of
    the cottage. Raise a barracks before Dushana arrives, spearmen before Trisiras'
    cavalry, and a watchtower never hurts. Food fuels the heroes' astras.</p>`,
};

// ============================================================================
// Scripted beats — each one terminates via timeout (theater law).
// ============================================================================

/** Live hermitage center, with a static fallback so beats never crash. */
function hermitagePos(game: Game, ms: AranyaState): Vec2 {
  const e = ms.hermitageId != null ? game.entities.get(ms.hermitageId) : undefined;
  if (e && !e.dead) return e.pos;
  return tileCenter(HERMITAGE_TILE.tx + 1, HERMITAGE_TILE.ty + 1);
}

/** Remove a theater unit without death FX (reaped ~1s later by the engine). */
function silentRemove(game: Game, e: Entity) {
  if (e.dead) return;
  e.dead = true;
  e.deathAt = game.simTime;
  game.selectedIds.delete(e.id);
}

// --- Beat 1: Shurpanakha's walk-in (~150s) --------------------------------
// One rakshasi walks from the west edge toward the hermitage. On proximity
// (or a 60s timeout) the flee beat fires; she routs west and despawns after
// 20s. She never attacks; if she is killed early, the beat degrades to a line.
function tickShurpanakha(game: Game, ms: AranyaState, now: number) {
  if (ms.shurpanakhaPhase === 'done') return;

  if (!ms.shurpanakhaPhase) {
    if (now < T(SHURPANAKHA_AT)) return;
    const e = game.spawnUnit('villager_enemy', 2, tileCenter(2, 47));
    e.hp = 200;               // a stray arrow must not end the scene early
    e.maxHp = 200;
    e.attackDmg = 0;          // pure theater — she never fights
    e.nextOrderAt = Infinity; // keep the WaveDirector's hands off her
    ms.shurpanakhaPhase = 'approach';
    ms.shurpanakhaId = e.id;
    ms.shurpanakhaCutAt = now + SHURPANAKHA_TIMEOUT;
    ms.shurpanakhaPokeAt = 0;
    game.notify('A rakshasi drifts out of the western trees, eyes fixed on the hermitage…');
    return;
  }

  const e = ms.shurpanakhaId != null ? game.entities.get(ms.shurpanakhaId) : undefined;
  if (!e || e.dead) {
    // Killed early — skip ahead gracefully; the vengeance still comes.
    if (ms.shurpanakhaPhase === 'approach') {
      game.alertWave('Shurpanakha falls — her brothers will come for vengeance!', 2.6);
    }
    ms.shurpanakhaPhase = 'done';
    return;
  }

  const herm = hermitagePos(game, ms);
  if (ms.shurpanakhaPhase === 'approach') {
    const dx = e.pos.x - herm.x;
    const dy = e.pos.y - herm.y;
    const near = dx * dx + dy * dy <= (4.5 * TILE_SIZE) ** 2;
    if (near || now >= (ms.shurpanakhaCutAt ?? 0)) {
      const line = "Lakshmana's blade flashes — Shurpanakha flees, disfigured, shrieking vengeance";
      game.addShake(8);
      game.notify(line);
      game.alertWave(line, 3.2);
      ms.shurpanakhaPhase = 'rout';
      ms.shurpanakhaGoneAt = now + SHURPANAKHA_ROUT_DESPAWN;
      ms.shurpanakhaPokeAt = 0;
    } else if (now >= (ms.shurpanakhaPokeAt ?? 0)) {
      ms.shurpanakhaPokeAt = now + 2;
      game.issueCommand(e, { kind: 'move', pos: { x: herm.x - 3 * TILE_SIZE, y: herm.y } });
    }
    return;
  }

  // 'rout' — flee to the west edge, then vanish quietly.
  if (now >= (ms.shurpanakhaGoneAt ?? 0)) {
    silentRemove(game, e);
    ms.shurpanakhaPhase = 'done';
  } else if (now >= (ms.shurpanakhaPokeAt ?? 0)) {
    ms.shurpanakhaPokeAt = now + 2;
    const row = Math.max(1, Math.min(WATER_TOP - 2, Math.floor(e.pos.y / TILE_SIZE)));
    game.issueCommand(e, { kind: 'move', pos: tileCenter(1, row) });
  }
}

// --- Beat 2: The Golden Deer (~700s) ---------------------------------------
// A golden deer wanders the NW clearing. Kill it: +200 gold, Maricha ambushes
// from the glade. Ignore it: at the finale it vanishes and Maricha marches
// with Khara's host instead. Both branches converge; neither gates the win.
function tickGoldenDeer(game: Game, ms: AranyaState, now: number) {
  if (ms.deerPhase === 'resolved') return;

  if (!ms.deerPhase) {
    if (now < T(DEER_AT)) return;
    const e = game.spawnUnit('golden_deer', 2, tileCenter(DEER_HOME.tx, DEER_HOME.ty));
    e.nextOrderAt = Infinity; // never re-aimed at the hermitage by the director
    e.facingAngle = game.rng() * Math.PI * 2;
    ms.deerPhase = 'alive';
    ms.deerId = e.id;
    ms.deerLastX = e.pos.x;
    ms.deerLastY = e.pos.y;
    ms.deerWanderAt = now + 2;
    game.notify('A deer of living gold steps between the trees to the northwest…');
    return;
  }

  const e = ms.deerId != null ? game.entities.get(ms.deerId) : undefined;
  const herm = hermitagePos(game, ms);

  if (!e || e.dead) {
    // The bait was taken.
    ms.deerPhase = 'resolved';
    game.resources[1].gold += 200;
    game.notify('+200 gold — but a scream echoes… Maricha!');
    game.alertWave('MARICHA SPRINGS THE TRAP', 2.6);
    game.addShake(6);
    const at: Vec2 = { x: ms.deerLastX ?? 0, y: ms.deerLastY ?? 0 };
    // The ambush jumps the nearest player unit — usually the hunter.
    let quarry: Entity | null = null;
    let bestD = Infinity;
    for (const u of game.entities.values()) {
      if (u.owner !== 1 || u.kind !== 'unit' || u.dead) continue;
      const dx = u.pos.x - at.x;
      const dy = u.pos.y - at.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; quarry = u; }
    }
    const band = ['maricha', 'grunt_enemy', 'grunt_enemy', 'grunt_enemy'];
    for (let i = 0; i < band.length; i++) {
      const ang = (i / band.length) * Math.PI * 2;
      const r = game.spawnUnit(band[i], 2, {
        x: at.x + Math.cos(ang) * TILE_SIZE,
        y: at.y + Math.sin(ang) * TILE_SIZE,
      });
      if (quarry) game.issueCommand(r, { kind: 'attack', targetId: quarry.id });
      else game.issueCommand(r, { kind: 'attackMove', pos: { ...herm } });
    }
    return;
  }

  if (now >= T(FINALE_AT)) {
    // Bait untaken — the illusion dissolves and Maricha joins the host.
    silentRemove(game, e);
    ms.deerPhase = 'resolved';
    const m = game.spawnUnit('maricha', 2, tileCenter(2, 34));
    game.issueCommand(m, { kind: 'attackMove', pos: { ...herm } });
    game.notify("The golden deer bounds away unseen… Maricha joins Khara's host!");
    return;
  }

  // Gentle wander around the clearing (wildlife only drives typeId 'deer').
  ms.deerLastX = e.pos.x;
  ms.deerLastY = e.pos.y;
  if (now >= (ms.deerWanderAt ?? 0)) {
    ms.deerWanderAt = now + 2.5 + game.rng() * 2;
    const tx = Math.max(2, DEER_HOME.tx + Math.round((game.rng() - 0.5) * 9));
    const ty = Math.max(2, DEER_HOME.ty + Math.round((game.rng() - 0.5) * 9));
    game.issueCommand(e, { kind: 'move', pos: tileCenter(tx, ty) });
  }
}

// --- Beat 3: Khara's fall and the rout -------------------------------------
// The WaveDirector spawns Khara (middle host wave); this beat only watches.
// kharaSeen flips the moment he exists; kharaDead when no living Khara
// remains afterward (never rescans a reaped corpse). A fallback timestamp
// keeps the win reachable even if his spawn were somehow dropped. On his
// death the whole host routs to the nearest edge and evaporates after 45s —
// late waves that spawn mid-rout are swept into the same flight.
function tickKharaRout(game: Game, ms: AranyaState, now: number) {
  if (!ms.kharaDead) {
    let alive = false;
    let seen = !!ms.kharaSeen;
    for (const e of game.entities.values()) {
      if (e.typeId !== 'khara') continue;
      seen = true;
      if (!e.dead) alive = true;
    }
    if (seen) ms.kharaSeen = true;
    const fallbackAt = T(KHARA_AT) + 90;
    if ((seen && !alive) || (!seen && now >= fallbackAt)) {
      ms.kharaDead = true;
      ms.routEndAt = now + ROUT_CLEANUP;
      ms.routBannerAt = now + 3; // let "KHARA HAS FALLEN" own the banner first
      game.notify('The host breaks and flees!');
    } else {
      return;
    }
  }
  if (ms.routFinished) return;

  if ((ms.routBannerAt ?? 0) > 0 && now >= (ms.routBannerAt ?? 0)) {
    game.alertWave('The host breaks and flees!', 3.0);
    ms.routBannerAt = 0;
  }

  const cleanup = now >= (ms.routEndAt ?? 0);
  for (const e of game.entities.values()) {
    if (e.owner !== 2 || e.kind !== 'unit' || e.dead) continue;
    if (cleanup) {
      silentRemove(game, e);
      continue;
    }
    // nextOrderAt === Infinity doubles as the "already routing" marker (and
    // keeps the WaveDirector from re-aiming the fugitive at the hermitage).
    if (e.nextOrderAt !== Infinity) {
      e.nextOrderAt = Infinity;
      game.issueCommand(e, { kind: 'move', pos: fleePoint(e.pos) });
    }
  }
  if (cleanup) ms.routFinished = true;
}

/** Nearest map edge, except south stops at the Godavari's bank. */
function fleePoint(pos: Vec2): Vec2 {
  const bankY = (WATER_TOP - 1.5) * TILE_SIZE;
  const dW = pos.x;
  const dE = MAP_W - pos.x;
  const dN = pos.y;
  const dS = Math.max(0, bankY - pos.y);
  const m = Math.min(dW, dE, dN, dS);
  if (m === dN) return { x: pos.x, y: TILE_SIZE * 1.5 };
  if (m === dW) return { x: TILE_SIZE * 1.5, y: Math.min(pos.y, bankY) };
  if (m === dE) return { x: MAP_W - TILE_SIZE * 1.5, y: Math.min(pos.y, bankY) };
  return { x: pos.x, y: bankY };
}

// ============================================================================
// Terrain
// ============================================================================

function paintTerrain(game: Game) {
  // The Godavari — a wide band along the south with a single sandy ford.
  for (let y = WATER_TOP; y <= WATER_BOTTOM; y++) {
    for (let x = 0; x < MAP_TILES_X; x++) {
      if (x >= FORD_X0 && x <= FORD_X1) continue;
      game.world.setTerrain(x, y, 'water');
    }
  }
  // The ford itself and its banks read as trodden earth.
  const yMax = Math.min(WATER_BOTTOM + 1, MAP_TILES_Y - 1);
  for (let y = WATER_TOP - 1; y <= yMax; y++) {
    for (let x = FORD_X0; x <= FORD_X1; x++) game.world.setTerrain(x, y, 'dirt');
  }
  // A worn footpath from the ford up to the hermitage clearing.
  for (let x = FORD_X1; x <= 41; x++) game.world.setTerrain(x, 52, 'dirt');
  for (let y = 48; y <= 52; y++) game.world.setTerrain(41, y, 'dirt');
}
