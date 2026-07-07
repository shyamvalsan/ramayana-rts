// Mission III — Yuddha Kanda: "The Siege of Lanka".
//
// The dormant skirmish revived: full player economy versus a prebuilt island
// fortress. A sea channel severs the NE third of the map; Nala's Setu — one
// four-tile causeway — is the only crossing. The parameterized economy AI
// runs Lanka while a scripted boss ladder (Prahasta → Kumbhakarna → the
// Nagapasha/Indrajit → Ravana) provides the difficulty floor.
//
// Win:  the Citadel is destroyed AND Ravana is slain (order-agnostic).
// Lose: Rama dies, Lakshmana dies, or the player Town Center falls.
//
// LAW (scope-realist): no beat gates the win without a timeout. Kumbhakarna
// has a hard clock fallback; the Nagapasha fires on a fallback clock even if
// Kumbhakarna is never killed; Ravana's trigger sits on the win path itself
// (you cannot destroy the citadel without passing 40% hp).

import { MAP_TILES_X, MAP_TILES_Y } from '@/config/constants';
import { UNIT_DEFS, type UnitDef } from '@/config/units';
import type { Game } from '@/core/game';
import type { Entity, ResourceKind, TilePos, Vec2 } from '@/core/types';
import { findPath } from '@/core/pathfinding';
import { tileCenter } from '@/util/math';
import type { MissionDef, Outcome } from '@/missions/types';
import { spawnForest } from '@/missions/balaKanda';
import { AIController, type AIConfig } from '@/systems/ai';

// ============================== Balance knobs ==============================
/** Citadel durability multiplier (applied to hp/maxHp after spawn). */
const CITADEL_HP_MULT = 1;
/** Scales the scripted sortie sizes (Prahasta escort, Nagapasha escort). */
const SORTIE_SCALE = 1;

// Boss-ladder timing (seconds of sim time).
const PRAHASTA_AT = 300;
const KUMBHAKARNA_FALLBACK_AT = 960;   // wakes by damage, or by this clock
const NAGAPASHA_AFTER_KUMBHA_DEATH = 60;
const NAGAPASHA_FALLBACK_AFTER_SPAWN = 480; // fires even if Kumbhakarna lives
const NAGAPASHA_STUN = 15;
const RAVANA_CITADEL_HP_FRAC = 0.4;

// ============================== Geometry ==================================
// Diagonal coordinates: s = tx - ty + MAP_TILES_Y grows toward the NE corner;
// u = tx + ty is constant along the NE-SW crossing direction.
// The channel is the band CHANNEL_S_LO <= s < CHANNEL_S_HI (water); the
// island is everything with s >= CHANNEL_S_HI (~595 land tiles).
const CHANNEL_S_LO = 98;
const CHANNEL_S_HI = 106;
// Nala's Setu: dirt where u falls in [CAUSEWAY_U_LO, CAUSEWAY_U_HI] inside
// the band — a ~4-tile-wide crossing centered near tile (60, 18).
const CAUSEWAY_U_LO = 75;
const CAUSEWAY_U_HI = 80;

const CAUSEWAY_CENTER: TilePos = { tx: 60, ty: 18 };   // mid-channel
const GATEFRONT: TilePos = { tx: 62, ty: 15 };         // island end of the Setu
const CITADEL_TILE: TilePos = { tx: 70, ty: 8 };       // 4x4 top-left
const PLAYER_TC_TILE: TilePos = { tx: 8, ty: 46 };     // 4x4 top-left

// ====================== Boss defs (registered here) =======================
// Bosses reuse existing sprite sets via spriteBase + sizeScale + tintColor
// (tint MUST carry its own alpha). trainTime 0 / cost {} / popCost 0: these
// are script-spawned only.
Object.assign(UNIT_DEFS, {
  prahasta: {
    typeId: 'prahasta',
    name: 'Prahasta',
    description: "Ravana's field marshal. Leads the first sortie across the Setu.",
    hp: 500, radius: 13, speed: 85,
    attackDmg: 16, attackRange: 24, attackSpeed: 1.0, armor: 2,
    spriteBase: 'grunt_enemy', bossTier: 'mid', sizeScale: 1.3,
    trainTime: 0, cost: {}, popCost: 0, builtAt: [],
    primaryColor: '#8b3030', accentColor: '#1a0a0a', weaponColor: '#1a1a1a',
    ranged: false,
  },
  kumbhakarna: {
    typeId: 'kumbhakarna',
    name: 'Kumbhakarna',
    description: "Ravana's colossal brother, wakened from his half-year sleep.",
    hp: 1500, radius: 22, speed: 55,
    attackDmg: 34, attackRange: 30, attackSpeed: 0.6, armor: 4,
    spriteBase: 'tataka', bossTier: 'major', sizeScale: 1.6,
    tintColor: 'rgba(200, 120, 40, 0.3)',
    trainTime: 0, cost: {}, popCost: 0, builtAt: [],
    primaryColor: '#7a4a20', accentColor: '#2a1000', weaponColor: '#1a1a1a',
    ranged: false,
  },
  indrajit: {
    typeId: 'indrajit',
    name: 'Indrajit',
    description: "Ravana's son, conqueror of Indra. Master of the serpent arrows.",
    hp: 700, radius: 12, speed: 110,
    attackDmg: 20, attackRange: 130, attackSpeed: 1.1, armor: 2,
    spriteBase: 'maricha', bossTier: 'major', sizeScale: 1.3,
    tintColor: 'rgba(60, 200, 160, 0.3)',
    trainTime: 0, cost: {}, popCost: 0, builtAt: [],
    primaryColor: '#3a6a5a', accentColor: '#0a1a14', weaponColor: '#a08050',
    ranged: true,
  },
  ravana: {
    typeId: 'ravana',
    name: 'Ravana',
    description: 'The ten-headed lord of Lanka. The war ends only with him.',
    hp: 1500, radius: 17, speed: 75,
    attackDmg: 30, attackRange: 28, attackSpeed: 1.0, armor: 4,
    spriteBase: 'subahu', bossTier: 'major', sizeScale: 1.55,
    tintColor: 'rgba(40, 40, 90, 0.45)',
    trainTime: 0, cost: {}, popCost: 0, builtAt: [],
    primaryColor: '#2a2a50', accentColor: '#0a0a1a', weaponColor: '#c0b060',
    ranged: false,
  },
} satisfies Record<string, UnitDef>);

// ====================== Lanka's siege AI configuration ====================
const LANKA_SIEGE_CONFIG: AIConfig = {
  villagerType: 'villager_enemy',
  houseType: 'house_enemy',
  camps: { lumber: 'lumber_camp_enemy', mill: 'mill_enemy', mining: 'mining_camp_enemy' },
  military: { barracks: 'barracks_enemy', range: 'archery_range_enemy', stable: 'stable_enemy' },
  trainable: { spear: 'spearman_enemy', archer: 'archer_enemy', cavalry: 'cavalry_enemy' },
  attackTargetTypeIds: ['town_center'],
  targetOwner: 1,
  villagerCap: 14,
  attackWave: { firstAt: 240, interval: 100, sizeRamp: 1 },
};

// ============================ Mission scratch =============================
// All beat memory lives in game.missionState (fresh per Game, restart-safe).
interface YuddhaState {
  nextThinkAt?: number;
  citadelId?: number;
  citadelDead?: boolean;
  prahastaDone?: boolean;
  kumbhaId?: number;
  kumbhaSpawnedAt?: number;
  kumbhaDead?: boolean;
  kumbhaDeadAt?: number;
  nagaDone?: boolean;
  garudaAt?: number;
  garudaDone?: boolean;
  ravanaSpawned?: boolean;
  ravanaId?: number;
  ravanaDead?: boolean;
}

const S = (game: Game): YuddhaState => game.missionState as YuddhaState;

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, '0')}`;
}

export const yuddhaKanda: MissionDef = {
  id: 'yuddha-kanda',
  chapter: 'Yuddha Kanda',
  title: 'The Siege of Lanka',
  description:
    'The army stands at the shore of the southern sea. Nala\'s bridge of stone '
    + 'reaches across the channel to Ravana\'s island fortress. Raise a war '
    + 'economy on the beachhead, force the Setu, break the Citadel — and face '
    + 'the ten-headed king himself.',
  teaserKey: 'teaser-yuddha-kanda',
  requires: ['aranya-kanda'],
  heroes: [
    { typeId: 'rama', abilityId: 'brahmastra', hotkey: 'q' },
    { typeId: 'lakshmana', abilityId: 'indrastra', hotkey: 'e' },
  ],
  anchorTypeIds: ['town_center'],
  showWaveCounter: false,
  economyEnabled: true,
  techIds: ['bala_mantra', 'atibala_mantra', 'sabaris_offering', 'agastyas_armory', 'agneyastra_tips', 'vigil_of_jatayu', 'vayus_swiftness', 'indras_kavacha', 'nalas_masonry', 'sanjivani_herb'],

  load(game: Game) {
    // Fresh beat state (restart-safe even if missionState is reused).
    Object.assign(game.missionState, {
      nextThinkAt: 0,
      citadelId: 0,
      citadelDead: false,
      prahastaDone: false,
      kumbhaId: 0,
      kumbhaSpawnedAt: undefined,
      kumbhaDead: false,
      kumbhaDeadAt: undefined,
      nagaDone: false,
      garudaAt: undefined,
      garudaDone: false,
      ravanaSpawned: false,
      ravanaId: 0,
      ravanaDead: false,
    } satisfies YuddhaState);

    paintTerrain(game, CAUSEWAY_U_LO, CAUSEWAY_U_HI);

    // ===== Player beachhead (SW) =====
    game.spawnBuilding('town_center', 1, PLAYER_TC_TILE, false);
    game.popCapBase[1] = 15; // beachhead expedition camp: 14 starting pop must fit
    // Siege-economy kickstart on top of the global STARTING_RESOURCES.
    game.resources[1].wood += 200;
    game.resources[1].food += 100;

    const villagerSpots: TilePos[] = [
      { tx: 13, ty: 46 }, { tx: 13, ty: 47 }, { tx: 13, ty: 48 },
      { tx: 13, ty: 49 }, { tx: 12, ty: 50 }, { tx: 11, ty: 50 },
    ];
    for (const t of villagerSpots) game.spawnUnit('villager', 1, tileCenter(t.tx, t.ty));
    game.spawnUnit('rama',      1, tileCenter(13, 51));
    game.spawnUnit('lakshmana', 1, tileCenter(14, 51));
    for (let i = 0; i < 4; i++) game.spawnUnit('spearman', 1, tileCenter(7 + i, 51));
    for (let i = 0; i < 4; i++) game.spawnUnit('archer',   1, tileCenter(7 + i, 52));

    // ===== Lanka, prebuilt on the NE island (owner 2) =====
    const citadel = game.spawnBuilding('town_center_enemy', 2, CITADEL_TILE, false);
    citadel.hp = Math.round(citadel.hp * CITADEL_HP_MULT);
    citadel.maxHp = Math.round(citadel.maxHp * CITADEL_HP_MULT);
    S(game).citadelId = citadel.id;

    const houseTiles: TilePos[] = [
      { tx: 75, ty: 4 }, { tx: 75, ty: 7 }, { tx: 75, ty: 13 }, { tx: 71, ty: 5 },
    ];
    for (const t of houseTiles) game.spawnBuilding('house_enemy', 2, t, false);
    game.spawnBuilding('barracks_enemy',      2, { tx: 64, ty: 6 },  false);
    game.spawnBuilding('archery_range_enemy', 2, { tx: 64, ty: 12 }, false);
    game.spawnBuilding('stable_enemy',        2, { tx: 68, ty: 14 }, false);
    game.spawnBuilding('lumber_camp_enemy',   2, { tx: 60, ty: 5 },  false);
    game.spawnBuilding('mining_camp_enemy',   2, { tx: 72, ty: 18 }, false);

    // Watchtower ring along the island's channel-facing coast; two flank the
    // Setu's landing.
    const towerTiles: TilePos[] = [
      { tx: 58, ty: 8 }, { tx: 60, ty: 12 }, { tx: 66, ty: 18 },
      { tx: 70, ty: 22 }, { tx: 75, ty: 26 },
    ];
    for (const t of towerTiles) game.spawnBuilding('watchtower', 2, t, false);

    // Fat stockpile so the siege AI never starves.
    game.resources[2] = { wood: 1200, food: 1200, gold: 800, stone: 600 };

    // ===== Island resources (veins/bushes BEFORE forests so trees skip them) =====
    const islandGold: TilePos[] = [
      { tx: 74, ty: 20 }, { tx: 75, ty: 20 }, { tx: 74, ty: 21 }, { tx: 76, ty: 22 },
    ];
    for (const t of islandGold) game.spawnResourceNode('gold_vein', t);
    const islandStone: TilePos[] = [
      { tx: 69, ty: 20 }, { tx: 70, ty: 20 }, { tx: 70, ty: 21 },
    ];
    for (const t of islandStone) game.spawnResourceNode('stone_vein', t);
    const islandBerries: TilePos[] = [
      { tx: 67, ty: 4 }, { tx: 68, ty: 4 }, { tx: 69, ty: 4 },
      { tx: 67, ty: 5 }, { tx: 68, ty: 5 }, { tx: 69, ty: 5 },
    ];
    for (const t of islandBerries) game.spawnResourceNode('berry_bush', t);
    spawnForest(game, 52, 1, 8, 6);   // NW shore woods (clips itself at water)
    spawnForest(game, 65, 1, 9, 3);   // north woods behind the citadel
    spawnForest(game, 74, 17, 5, 8);  // SE woods near the mining camp

    // ===== Mainland resources for the siege economy =====
    spawnForest(game, 2, 38, 8, 8);   // NW of the beachhead
    spawnForest(game, 16, 52, 6, 6);  // SE of the beachhead
    spawnForest(game, 4, 54, 8, 5);   // south woods
    const shoreBerries: TilePos[] = [
      { tx: 14, ty: 44 }, { tx: 15, ty: 44 }, { tx: 16, ty: 44 },
      { tx: 14, ty: 45 }, { tx: 15, ty: 45 }, { tx: 16, ty: 45 },
    ];
    for (const t of shoreBerries) game.spawnResourceNode('berry_bush', t);
    const mainGold: TilePos[] = [
      { tx: 26, ty: 36 }, { tx: 27, ty: 36 }, { tx: 26, ty: 37 }, { tx: 27, ty: 37 },
    ];
    for (const t of mainGold) game.spawnResourceNode('gold_vein', t);
    const mainStone: TilePos[] = [
      { tx: 30, ty: 38 }, { tx: 31, ty: 38 }, { tx: 30, ty: 39 },
    ];
    for (const t of mainStone) game.spawnResourceNode('stone_vein', t);
    const deerSpots: TilePos[] = [
      { tx: 20, ty: 30 }, { tx: 35, ty: 45 }, { tx: 28, ty: 52 }, { tx: 45, ty: 40 },
    ];
    for (const t of deerSpots) {
      const e = game.spawnUnit('deer', 0, tileCenter(t.tx, t.ty));
      e.facingAngle = game.rng() * Math.PI * 2;
    }

    // ===== Lanka's population: workers pre-assigned + a standing garrison =====
    const workerKinds: ResourceKind[] = [
      'wood', 'wood', 'wood', 'wood', 'gold', 'gold', 'stone', 'stone',
    ];
    for (let i = 0; i < workerKinds.length; i++) {
      const spot = findPassableNear(game, 67 + (i % 3), 9 + Math.floor(i / 3));
      const v = game.spawnUnit('villager_enemy', 2, tileCenter(spot.tx, spot.ty));
      const node = nearestResource(game, v.pos, workerKinds[i]);
      if (node) game.issueCommand(v, { kind: 'gather', targetId: node.id });
    }
    const garrison: Array<{ typeId: string; tx: number; ty: number }> = [
      { typeId: 'spearman_enemy', tx: 63, ty: 10 },
      { typeId: 'spearman_enemy', tx: 63, ty: 11 },
      { typeId: 'archer_enemy',   tx: 65, ty: 10 },
      { typeId: 'archer_enemy',   tx: 65, ty: 11 },
      { typeId: 'cavalry_enemy',  tx: 68, ty: 12 },
      { typeId: 'cavalry_enemy',  tx: 69, ty: 12 },
    ];
    for (const g of garrison) {
      const spot = findPassableNear(game, g.tx, g.ty);
      game.spawnUnit(g.typeId, 2, tileCenter(spot.tx, spot.ty));
    }

    // ===== Enemy brain: the parameterized economy AI, tuned for the siege =====
    game.ais.set(2, new AIController(2, LANKA_SIEGE_CONFIG));

    // ===== Reachability sanity check: the Setu must actually connect =====
    // If A* can't reach the citadel from the beachhead, widen the causeway
    // and retry (never ship an unwinnable map).
    for (let attempt = 0; attempt < 3; attempt++) {
      const path = findPath(game.world, { tx: 13, ty: 47 }, CITADEL_TILE);
      if (path) break;
      paintTerrain(game, CAUSEWAY_U_LO - 2 * (attempt + 1), CAUSEWAY_U_HI + 2 * (attempt + 1));
    }
  },

  tick(game: Game) {
    const ms = S(game);
    const t = game.simTime;
    if (t < (ms.nextThinkAt ?? 0)) return;   // throttled scans (4 Hz)
    ms.nextThinkAt = t + 0.25;

    // ---- Observe deaths and latch flags (corpses are reaped ~1s after
    // death, well within the 0.25s scan window). ----
    const citadel = ms.citadelId ? game.entities.get(ms.citadelId) : undefined;
    if (!ms.citadelDead && (!citadel || citadel.dead)) ms.citadelDead = true;
    if (ms.kumbhaId && !ms.kumbhaDead) {
      const k = game.entities.get(ms.kumbhaId);
      if (!k || k.dead) { ms.kumbhaDead = true; ms.kumbhaDeadAt = t; }
    }
    if (ms.ravanaId && ms.ravanaSpawned && !ms.ravanaDead) {
      const r = game.entities.get(ms.ravanaId);
      if (!r || r.dead) ms.ravanaDead = true;
    }

    const tcPos = playerTcPos(game);

    // ---- Beat 1: Prahasta's sortie across the Setu (~5:00). ----
    if (!ms.prahastaDone && t >= PRAHASTA_AT) {
      ms.prahastaDone = true;
      spawnAttacker(game, 'prahasta', GATEFRONT, tcPos);
      game.addShake(6);
      const grunts = Math.max(1, Math.round(4 * SORTIE_SCALE));
      for (let i = 0; i < grunts; i++) {
        spawnAttacker(game, 'grunt_enemy', { tx: GATEFRONT.tx - 1 + (i % 2), ty: GATEFRONT.ty + 1 + Math.floor(i / 2) }, tcPos);
      }
      game.notify('Prahasta leads the sortie across the Setu!');
    }

    // ---- Beat 2: Kumbhakarna wakes — first damage to the Citadel or any
    // Lanka watchtower, or the hard clock fallback. ----
    if (!ms.kumbhaId && (t >= KUMBHAKARNA_FALLBACK_AT || lankaStructuresDamaged(game, citadel, ms))) {
      const k = spawnAttacker(game, 'kumbhakarna', { tx: CITADEL_TILE.tx - 2, ty: CITADEL_TILE.ty + 4 }, tcPos);
      ms.kumbhaId = k.id;
      ms.kumbhaSpawnedAt = t;
      game.alertWave('Drums roll in Lanka — Ravana has wakened Kumbhakarna!', 3.0);
      game.addShake(14);
    }

    // ---- Beat 3: the Nagapasha — 60s after Kumbhakarna falls (fallback
    // clock if he never does; the stun must not gate on a kill). ----
    if (!ms.nagaDone && ms.kumbhaSpawnedAt !== undefined) {
      const due = ms.kumbhaDeadAt !== undefined
        ? ms.kumbhaDeadAt + NAGAPASHA_AFTER_KUMBHA_DEATH
        : ms.kumbhaSpawnedAt + NAGAPASHA_FALLBACK_AFTER_SPAWN;
      if (t >= due) {
        ms.nagaDone = true;
        ms.garudaAt = t + NAGAPASHA_STUN;
        game.alertWave('Indrajit rises unseen — the serpent arrows fly!', 3.0);
        for (const e of game.entities.values()) {
          if (e.dead || e.owner !== 1) continue;
          if (e.typeId !== 'rama' && e.typeId !== 'lakshmana') continue;
          e.state = { kind: 'idle' };
          e.commandQueue = [];
          e.stunnedUntil = t + NAGAPASHA_STUN;
        }
        // Fixed escort sortie — scripted, never a random AI wave.
        const grunts = Math.max(1, Math.round(6 * SORTIE_SCALE));
        const archers = Math.max(1, Math.round(3 * SORTIE_SCALE));
        for (let i = 0; i < grunts; i++) {
          spawnAttacker(game, 'grunt_enemy', { tx: CAUSEWAY_CENTER.tx - 1 + (i % 3), ty: CAUSEWAY_CENTER.ty - 1 + Math.floor(i / 3) }, tcPos);
        }
        for (let i = 0; i < archers; i++) {
          spawnAttacker(game, 'archer_enemy', { tx: CAUSEWAY_CENTER.tx + 1 + i, ty: CAUSEWAY_CENTER.ty - 2 }, tcPos);
        }
      }
    }

    // ---- Beat 3b: Garuda frees the princes; Indrajit takes the causeway. ----
    if (ms.nagaDone && !ms.garudaDone && t >= (ms.garudaAt ?? 0)) {
      ms.garudaDone = true;
      game.alertWave('Garuda descends on golden wings — the princes are freed!', 3.0);
      spawnAttacker(game, 'indrajit', GATEFRONT, tileCenter(CAUSEWAY_CENTER.tx, CAUSEWAY_CENTER.ty));
    }

    // ---- Beat 4: Ravana takes the field at citadel <40% (or destroyed) and
    // Aditya Hridayam is granted free. Sits on the win path — no timeout
    // needed: the win requires exactly the damage that triggers this. ----
    if (!ms.ravanaSpawned
      && (ms.citadelDead || (citadel && !citadel.dead && citadel.hp < citadel.maxHp * RAVANA_CITADEL_HP_FRAC))) {
      ms.ravanaSpawned = true;
      const r = spawnAttacker(
        game, 'ravana',
        { tx: CITADEL_TILE.tx + 4, ty: CITADEL_TILE.ty + 2 },
        tileCenter(CITADEL_TILE.tx + 2, CITADEL_TILE.ty + 2), // holds the citadel
      );
      ms.ravanaId = r.id;
      game.alertWave('RAVANA HIMSELF TAKES THE FIELD', 3.4);
      game.addShake(16);
      game.notify("Agastya's hymn rings out — Aditya Hridayam empowers the princes!");
      for (const e of game.entities.values()) {
        if (e.dead || e.owner !== 1) continue;
        if (e.typeId !== 'rama' && e.typeId !== 'lakshmana') continue;
        e.attackDmg = (e.attackDmg ?? 0) + 6;
        e.hp = Math.min(e.maxHp, e.hp + 60);
      }
    }
  },

  evaluateOutcome(game: Game): Outcome {
    // Pure read: live scans + latched missionState flags set by tick().
    let ramaAlive = false;
    let lakshmanaAlive = false;
    let playerTcAlive = false;
    for (const e of game.entities.values()) {
      if (e.dead) continue;
      if (e.kind === 'unit' && e.typeId === 'rama') ramaAlive = true;
      else if (e.kind === 'unit' && e.typeId === 'lakshmana') lakshmanaAlive = true;
      else if (e.kind === 'building' && e.owner === 1 && e.typeId === 'town_center') playerTcAlive = true;
    }
    if (!ramaAlive || !lakshmanaAlive || !playerTcAlive) return 'lost';
    const ms = S(game);
    if (ms.citadelDead && ms.ravanaSpawned && ms.ravanaDead) return 'won';
    return 'playing';
  },

  victoryText(game: Game) {
    return `Ravana falls, and with him the long night ends. The Citadel of Lanka
      lies broken; Sita walks free through its shattered gates.<br/><br/>
      Vibhishana is crowned in his brother's place, and the Pushpaka chariot
      turns north — to Ayodhya, to the coronation, to dharma restored.<br/><br/>
      <span style="color: var(--text-dim)">Yuddha Kanda complete in ${formatTime(game.simTime)}.</span>`;
  },

  defeatText(game: Game) {
    return `The sea swallows the sound of the drums. The Setu stands, but no
      army crosses it now.<br/><br/>
      Sita waits in the ashoka grove for a rescue that will not come.<br/><br/>
      <span style="color: var(--text-dim)">The siege broke after ${formatTime(game.simTime)}. Raise the banners again.</span>`;
  },

  helpHtml: `
    <p><b>Objective:</b> destroy the Lanka Citadel on the NE island AND slay Ravana.
    You lose if Rama, Lakshmana, or your Town Center falls.</p>
    <p><b>Nala's Setu</b> — the single causeway — is the only way across the channel,
    and every sortie Lanka sends must come down it too. Hold its mouth with spearmen
    and towers while your economy grows.</p>
    <p>Boom first: the island counterattacks ramp up over time. Bring spears for
    riders, archers behind them, and keep the heroes' astras (fed by food) for the
    rakshasa champions. Kumbhakarna is siege-grade — kite him, focus him, and don't
    let him reach the Town Center. When the Citadel burns low, Ravana himself will
    take the field.</p>`,
};

// ================================ Helpers =================================

/** Terrain pass: sea channel over the NE third + Nala's Setu (idempotent —
 *  re-running with a wider causeway only turns water into dirt). */
function paintTerrain(game: Game, causewayULo: number, causewayUHi: number) {
  for (let ty = 0; ty < MAP_TILES_Y; ty++) {
    for (let tx = 0; tx < MAP_TILES_X; tx++) {
      const s = tx - ty + MAP_TILES_Y;   // grows toward the NE corner
      const u = tx + ty;                 // constant along the crossing
      const onCauseway = u >= causewayULo && u <= causewayUHi;
      if (s >= CHANNEL_S_LO && s < CHANNEL_S_HI) {
        game.world.setTerrain(tx, ty, onCauseway ? 'dirt' : 'water');
      } else if (onCauseway && s >= CHANNEL_S_LO - 3 && s < CHANNEL_S_HI + 3) {
        // Dirt ramps where the Setu meets each shore (cosmetic).
        game.world.setTerrain(tx, ty, 'dirt');
      }
    }
  }
}

/** Nearest passable tile to (tx, ty) — spiral out so scripted spawns never
 *  land in water or inside a footprint. */
function findPassableNear(game: Game, tx: number, ty: number): TilePos {
  if (game.world.isPassable(tx, ty)) return { tx, ty };
  for (let r = 1; r <= 6; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (game.world.isPassable(tx + dx, ty + dy)) return { tx: tx + dx, ty: ty + dy };
      }
    }
  }
  return { tx, ty };
}

/** Spawn a unit near a tile and attack-move it at a position. */
function spawnAttacker(game: Game, typeId: string, near: TilePos, target: Vec2): Entity {
  const spot = findPassableNear(game, near.tx, near.ty);
  const e = game.spawnUnit(typeId, 2, tileCenter(spot.tx, spot.ty));
  game.issueCommand(e, { kind: 'attackMove', pos: target });
  return e;
}

function nearestResource(game: Game, from: Vec2, kind: ResourceKind): Entity | null {
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const e of game.entities.values()) {
    if (e.kind !== 'resource' || e.dead) continue;
    if (e.resourceKind !== kind || (e.resourceRemaining ?? 0) <= 0) continue;
    const d = Math.hypot(e.pos.x - from.x, e.pos.y - from.y);
    if (d < bestD) { best = e; bestD = d; }
  }
  return best;
}

/** Where scripted sorties march: the player's TC (fallback: the beachhead). */
function playerTcPos(game: Game): Vec2 {
  for (const e of game.entities.values()) {
    if (e.kind === 'building' && e.owner === 1 && e.typeId === 'town_center' && !e.dead) {
      return e.pos;
    }
  }
  return tileCenter(PLAYER_TC_TILE.tx + 2, PLAYER_TC_TILE.ty + 2);
}

/** Kumbhakarna's wake trigger: the Citadel or any Lanka watchtower has taken
 *  damage (or the Citadel is already gone). */
function lankaStructuresDamaged(game: Game, citadel: Entity | undefined, ms: YuddhaState): boolean {
  if (ms.citadelDead) return true;
  if (citadel && !citadel.dead && citadel.hp < citadel.maxHp) return true;
  for (const e of game.entities.values()) {
    if (e.kind !== 'building' || e.owner !== 2 || e.typeId !== 'watchtower') continue;
    if (e.dead || e.hp < e.maxHp) return true;
  }
  return false;
}
