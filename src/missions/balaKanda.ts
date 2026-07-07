// Mission I — Bala Kanda: "The Sacred Fire".
//
// Vishwamitra's Yajna in the forest of Dandaka. The player commands Rama and
// Lakshmana defending the sacred fire from five escalating rakshasa waves;
// Tataka herself leads the last and enrages below half HP.
//
// Win:  Tataka has fallen AND no rakshasa remains on the field.
// Lose: The Yajna is destroyed, OR Rama dies, OR Vishwamitra dies.

import { MAP_TILES_X, MAP_TILES_Y } from '@/config/constants';
import type { Game } from '@/core/game';
import type { TilePos } from '@/core/types';
import { tileCenter } from '@/util/math';
import type { MissionDef, Outcome } from '@/missions/types';
import { WaveDirector, type WaveDef } from '@/missions/waveDirector';

const WAVES: WaveDef[] = [
  // New-player breathing room: ~45s of orientation before the first contact.
  { at: 45,  units: [{ typeId: 'grunt_enemy', count: 4 }], warning: 'Rakshasa scouts have found the Yajna!' },
  { at: 110, units: [{ typeId: 'grunt_enemy', count: 6 }, { typeId: 'spearman_enemy', count: 2 }], warning: 'A larger raiding band approaches.' },
  { at: 195, units: [{ typeId: 'grunt_enemy', count: 8 }, { typeId: 'spearman_enemy', count: 3 }, { typeId: 'maricha', count: 1 }], warning: 'Maricha the swift archer leads the third wave!' },
  { at: 290, units: [{ typeId: 'grunt_enemy', count: 8 }, { typeId: 'archer_enemy', count: 3 }, { typeId: 'subahu', count: 1 }], warning: 'Subahu the brute crashes through the trees!' },
  { at: 400, units: [{ typeId: 'grunt_enemy', count: 7 }, { typeId: 'spearman_enemy', count: 3 }, { typeId: 'archer_enemy', count: 2 }, { typeId: 'tataka', count: 1 }], warning: 'TATAKA RISES — DEFEND THE YAJNA!' },
];

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, '0')}`;
}

export const balaKanda: MissionDef = {
  id: 'bala-kanda',
  chapter: 'Bala Kanda',
  title: 'The Sacred Fire',
  description:
    'Sage Vishwamitra has called the princes into Dandaka to guard his Yajna. '
    + 'Five rakshasa waves will come; Tataka herself leads the last. '
    + 'Command Rama and Lakshmana — there is no army to raise, only skill and the astras.',
  teaserKey: 'cutscene-01',
  requires: [],
  heroes: [
    { typeId: 'rama', abilityId: 'brahmastra', hotkey: 'q' },
    { typeId: 'lakshmana', abilityId: 'indrastra', hotkey: 'e' },
  ],
  anchorTypeIds: ['yajna'],
  showWaveCounter: true,
  economyEnabled: false,
  cutsceneIds: ['cutscene-01', 'cutscene-02', 'cutscene-03', 'cutscene-04', 'cutscene-05', 'cutscene-06'],
  techIds: [],

  load(game: Game) {
    paintTerrain(game);

    // ===== The Yajna at map center =====
    const yajnaTile: TilePos = { tx: Math.floor(MAP_TILES_X / 2) - 1, ty: Math.floor(MAP_TILES_Y / 2) - 1 };
    game.spawnBuilding('yajna', 1, yajnaTile, false);

    // ===== Rama + Lakshmana flanking the altar =====
    game.spawnUnit('rama',      1, tileCenter(yajnaTile.tx - 2, yajnaTile.ty + 4));
    game.spawnUnit('lakshmana', 1, tileCenter(yajnaTile.tx + 4, yajnaTile.ty + 4));

    // ===== Vishwamitra + two rishis seated at the altar — VIPs to protect =====
    game.spawnUnit('vishwamitra', 1, tileCenter(yajnaTile.tx + 1, yajnaTile.ty - 1));
    game.spawnUnit('rishi',       1, tileCenter(yajnaTile.tx - 2, yajnaTile.ty + 1));
    game.spawnUnit('rishi',       1, tileCenter(yajnaTile.tx + 4, yajnaTile.ty + 1));

    // ===== Light forest cover scattered around the ritual ground =====
    spawnForest(game, yajnaTile.tx - 14, yajnaTile.ty - 12, 8, 9);
    spawnForest(game, yajnaTile.tx + 8,  yajnaTile.ty - 10, 7, 8);
    spawnForest(game, yajnaTile.tx - 16, yajnaTile.ty + 6,  7, 7);
    spawnForest(game, yajnaTile.tx + 10, yajnaTile.ty + 8,  6, 6);

    // ===== Wandering deer for food (ability fuel) =====
    const deerSpots: TilePos[] = [
      { tx: yajnaTile.tx - 18, ty: yajnaTile.ty - 6 },
      { tx: yajnaTile.tx - 10, ty: yajnaTile.ty + 10 },
      { tx: yajnaTile.tx + 14, ty: yajnaTile.ty - 4 },
      { tx: yajnaTile.tx + 6,  ty: yajnaTile.ty + 12 },
      { tx: yajnaTile.tx - 4,  ty: yajnaTile.ty - 14 },
      { tx: yajnaTile.tx + 18, ty: yajnaTile.ty + 6 },
    ];
    for (const s of deerSpots) {
      const e = game.spawnUnit('deer', 0, tileCenter(s.tx, s.ty));
      e.facingAngle = game.rng() * Math.PI * 2;
    }

    // ===== Wave director (rakshasa AI) =====
    const director = new WaveDirector({
      ownerId: 2,
      homePos: tileCenter(yajnaTile.tx + 1, yajnaTile.ty + 1),
      waves: WAVES,
      bossShake: { tataka: 14, subahu: 6, maricha: 6 },
    });
    game.ais.set(2, director);
  },

  tick(game: Game) {
    // Boss phase 2 transition when Tataka drops below 50% HP.
    if (game.bossPhase === 1) {
      for (const e of game.entities.values()) {
        if (e.typeId === 'tataka' && !e.dead && e.hp < e.maxHp * 0.5) {
          game.bossPhase = 2;
          game.bossEnragedAt = game.simTime;
          // Buff Tataka: faster + stronger. Visual phase change in renderer.
          e.speed = (e.speed ?? 60) * 1.35;
          e.attackDmg = (e.attackDmg ?? 24) * 1.4;
          e.attackSpeed = (e.attackSpeed ?? 0.8) * 1.2;
          game.alertWave('TATAKA RAGES — she grows stronger!', 2.6);
          game.addShake(10);
          break;
        }
      }
    }
  },

  evaluateOutcome(game: Game): Outcome {
    let yajnaAlive = false;
    let ramaAlive = false;
    let vishwamitraAlive = false;
    let tatakaAlive = false;
    let enemyUnitsAlive = false;
    for (const e of game.entities.values()) {
      if (e.dead) continue;
      if (e.kind === 'building' && e.typeId === 'yajna') yajnaAlive = true;
      if (e.kind === 'unit' && e.typeId === 'rama') ramaAlive = true;
      if (e.kind === 'unit' && e.typeId === 'vishwamitra') vishwamitraAlive = true;
      if (e.kind === 'unit' && e.typeId === 'tataka') tatakaAlive = true;
      if (e.owner === 2 && e.kind === 'unit') enemyUnitsAlive = true;
    }
    if (!yajnaAlive || !ramaAlive || !vishwamitraAlive) return 'lost';
    // tatakaEverSpawned persists past corpse reaping — never rescan for her.
    if (game.tatakaEverSpawned && !tatakaAlive && !enemyUnitsAlive) return 'won';
    return 'playing';
  },

  victoryText(game: Game) {
    return `Tataka has fallen. The Yajna burns on, sanctified by your defense.<br/><br/>
      Vishwamitra's blessing accompanies Rama and Lakshmana as they leave Dandaka.<br/><br/>
      <span style="color: var(--text-dim)">Bala Kanda complete in ${formatTime(game.simTime)}.</span>`;
  },

  defeatText(game: Game) {
    return `The Yajna's flame is extinguished. Rakshasas dance upon its ruined altar.<br/><br/>
      Vishwamitra weeps. The forest remembers.<br/><br/>
      <span style="color: var(--text-dim)">Survived ${formatTime(game.simTime)}. The princes must try again.</span>`;
  },

  helpHtml: `
    <p><b>Objective:</b> survive five rakshasa waves. The Yajna, Vishwamitra, and Rama
    must all survive. Kill Tataka and clear the field to win.</p>
    <p>Waves arrive from <b>one announced direction</b> — intercept them ahead of the
    altar. Hunt deer for food; food fuels the astras. Kite melee demons with your
    archer-heroes, and pull wounded heroes out — they mend when out of combat.</p>`,
};

function paintTerrain(game: Game) {
  // A small water pool to the east for character.
  for (let y = 22; y < 28; y++) {
    for (let x = MAP_TILES_X - 4; x < MAP_TILES_X; x++) {
      game.world.setTerrain(x, y, 'water');
    }
  }
  // Dirt path through the ritual ground.
  const cy = Math.floor(MAP_TILES_Y / 2);
  for (let x = 0; x < MAP_TILES_X; x++) {
    game.world.setTerrain(x, cy, 'dirt');
    game.world.setTerrain(x, cy + 1, 'dirt');
  }
}

export function spawnForest(game: Game, tx0: number, ty0: number, w: number, h: number) {
  let seed = ((tx0 * 73856093) ^ (ty0 * 19349663)) >>> 0;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed & 0xffff) / 65536;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const onEdge = x === 0 || x === w - 1 || y === 0 || y === h - 1;
      const p = onEdge ? 0.85 : 0.55;
      if (rand() > p) continue;
      const tx = tx0 + x, ty = ty0 + y;
      if (tx < 1 || ty < 1 || tx >= MAP_TILES_X - 1 || ty >= MAP_TILES_Y - 1) continue;
      if (!game.world.isPassable(tx, ty)) continue;
      game.spawnResourceNode('tree', { tx, ty });
    }
  }
}
