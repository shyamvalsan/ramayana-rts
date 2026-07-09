// Entry point. Wires Game + Camera + Input + Renderer + HUD + Tutorial +
// overlays + audio together and drives the simulation/render loop.

import './style.css';
import { SIM_DT } from '@/config/constants';
import { Camera } from '@/core/camera';
import { Game } from '@/core/game';
import { attachInput, makeInput } from '@/core/input';
import { render } from '@/render/renderer';
import { preloadSprites } from '@/render/sprites';
import { HUD } from '@/ui/hud';
import { MiniMap } from '@/ui/minimap';
import { TutorialManager } from '@/ui/tutorial';
import { HelpOverlay, SettingsPanel, CutscenePlayer, type SettingsState } from '@/ui/overlays';
import { MISSIONS, getMission, DEFAULT_MISSION_ID } from '@/missions';
import type { MissionDef } from '@/missions/types';
import { deserializeGame, loadFromSlot, saveToSlot } from '@/save';
import { initAudio, Sfx, startMusic, toggleMuted, isMuted, setMuted, setMusicState } from '@/audio/audio';
import { createAgentApi } from '@/agentApi';
import { AutoPlayer } from '@/systems/autoplayer';
import { asset } from '@/util/assets';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const overlay = document.getElementById('overlay') as HTMLElement;
const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
const endOverlay = document.getElementById('end-overlay') as HTMLElement;
const endTitle = document.getElementById('end-title') as HTMLElement;
const endText = document.getElementById('end-text') as HTMLElement;
const restartBtn = document.getElementById('restart-btn') as HTMLButtonElement;
const viewport = document.getElementById('viewport') as HTMLElement;
const uiOverlay = document.getElementById('ui-overlay') as HTMLElement;
const bbMinimap = document.getElementById('bb-minimap') as HTMLElement;

const params = new URLSearchParams(window.location.search);
const HEADLESS = params.has('headless');
const SKIP_INTRO = params.has('skipintro');
const AUTOPILOT = params.has('autopilot');

// Touch/small-screen visitors get a "play on desktop" notice rather than a
// broken canvas RTS. They can dismiss it ("Try anyway"). Skipped for headless.
if (!HEADLESS) {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const smallish = Math.min(window.innerWidth, window.innerHeight) < 640;
  if (coarse || smallish) {
    const gate = document.getElementById('device-gate');
    gate?.classList.remove('hidden');
    document.getElementById('device-anyway')?.addEventListener('click', () => {
      gate?.classList.add('hidden');
    });
  }
}
const initialSpeed = params.has('speed') ? parseFloat(params.get('speed')!) || 1 : 1;
let speedMultiplier = HEADLESS ? 10 : initialSpeed;
let paused = false;
let autoplayer: AutoPlayer | null = null;

// ===== Campaign state =====
// ?mission=<id> jumps straight to a mission (testing); otherwise the mission
// select drives it. Progress persists in localStorage.
const CAMPAIGN_KEY = 'rts-campaign-v1';
let currentMission: MissionDef = getMission(params.get('mission') ?? '') ?? getMission(DEFAULT_MISSION_ID)!;

function campaignProgress(): { completed: string[] } {
  try {
    const raw = localStorage.getItem(CAMPAIGN_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupted -> reset */ }
  return { completed: [] };
}
function markMissionCompleted(id: string) {
  const p = campaignProgress();
  if (!p.completed.includes(id)) {
    p.completed.push(id);
    localStorage.setItem(CAMPAIGN_KEY, JSON.stringify(p));
  }
}
function missionUnlocked(m: MissionDef): boolean {
  const done = campaignProgress().completed;
  return m.requires.every(r => done.includes(r));
}

let game = new Game();
const gameRef = { current: game };
const camera = new Camera();
const input = makeInput();
const hud = new HUD(game);
let minimap: MiniMap | null = null;
let tutorial: TutorialManager | null = null;

const help = new HelpOverlay(document.body);
const settings = new SettingsPanel();
const cutscene = new CutscenePlayer();

let running = false;
let lastFrame = 0;
let simAccumulator = 0;

function resize() {
  if (HEADLESS) return;
  // Canvas matches the viewport slot inside the frame, not the full window.
  const r = viewport.getBoundingClientRect();
  const w = Math.max(1, Math.floor(r.width));
  const h = Math.max(1, Math.floor(r.height));
  canvas.width = w * devicePixelRatio;
  canvas.height = h * devicePixelRatio;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  camera.resize(w, h);
}
window.addEventListener('resize', resize);
// Defer the initial resize to next frame so the grid layout settles first.
requestAnimationFrame(resize);

function newGame() {
  game = new Game();
  gameRef.current = game;
  game.mission = currentMission;
  currentMission.load(game);
  Object.assign(api, createAgentApi({
    get game() { return game; },
    setSpeedMultiplier: runner.setSpeedMultiplier,
    setPaused: runner.setPaused,
    manualStep: runner.manualStep,
  }));
  // Center camera AFTER one frame so any pending resize has settled. The
  // anchor is whatever the mission declares (Yajna, hermitage, town center).
  requestAnimationFrame(() => {
    let fallback: { x: number; y: number } | null = null;
    for (const e of game.entities.values()) {
      if (e.kind !== 'building' || e.owner !== 1) continue;
      if (currentMission.anchorTypeIds.includes(e.typeId)) {
        camera.centerOn(e.pos);
        return;
      }
      fallback ??= e.pos;
    }
    if (fallback) camera.centerOn(fallback);
  });
  // Apply settings to new game.
  game.fogEnabled = settings.state.fogEnabled;

  hud.setGame(game);
  bindHud();
  minimap = new MiniMap(bbMinimap, {
    game,
    camera,
    size: 144,
    onJumpTo: (wx, wy) => camera.centerOn({ x: wx, y: wy }),
  });
  // The scripted tutorial walks the Bala Kanda opening; other missions rely
  // on their briefing + help overlay.
  tutorial = currentMission.id === 'bala-kanda' ? new TutorialManager(uiOverlay, game) : null;
  // Hold the wave clock while the tutorial is on screen so a new player can
  // read and practice without being overrun; release it (waves begin) when the
  // briefing is finished or skipped.
  if (tutorial?.isActive) {
    game.waveHold = true;
    tutorial.onComplete = () => {
      game.waveHold = false;
      game.notify('The rakshasas approach — defend the Yajna!');
    };
  }
  // Spin up an AutoPlayer pointed at the mission anchor. It only acts when enabled.
  const anchorEnt = Array.from(game.entities.values()).find(
    e => e.kind === 'building' && e.owner === 1 && currentMission.anchorTypeIds.includes(e.typeId));
  const anchor = anchorEnt ? { x: anchorEnt.pos.x, y: anchorEnt.pos.y } : { x: 1280, y: 960 };
  autoplayer = new AutoPlayer({ api, anchorPos: anchor });
  autoplayer.enabled = AUTOPILOT;
  // Allow the layout grid to settle then resize the canvas to the new viewport.
  requestAnimationFrame(resize);
}

function bindHud() {
  hud.onBuildSelect = (typeId) => {
    game.pendingPlacement = { typeId };
    Sfx.click();
    hud.closeBuildMenu();
  };
  hud.onTrain = (building, unitTypeId) => {
    if (game.enqueueProduction(building, unitTypeId)) {
      Sfx.command();
    }
  };
  hud.onResearch = (building, techId) => {
    if (game.enqueueResearch(building, techId)) {
      Sfx.command();
    }
  };
  hud.onAbility = (caster, abilityId) => {
    pendingCast = { caster, abilityId };
    canvas.classList.add('casting');
    game.notify('Click a target location for the ability (Esc to cancel)');
  };

  hud.onUnitAction = (units, kind, arg) => {
    Sfx.command();
    // Special: cycle to next idle villager (triggered by the idle counter).
    if (arg === 'cycle-idle-villager') {
      const idle: any[] = [];
      for (const e of game.entities.values()) {
        if (e.kind === 'unit' && e.owner === 1 && e.typeId === 'villager' && !e.dead && e.state?.kind === 'idle') {
          idle.push(e);
        }
      }
      if (idle.length === 0) return;
      let target = idle[0];
      if (game.selectedIds.size === 1) {
        const sel = idle.findIndex(e => game.selectedIds.has(e.id));
        if (sel !== -1) target = idle[(sel + 1) % idle.length];
      }
      game.selectedIds.clear();
      game.selectedIds.add(target.id);
      camera.centerOn(target.pos);
      return;
    }
    if (kind === 'build') {
      hud.toggleBuildMenu();
      return;
    }
    if (kind === 'stop') {
      for (const u of units) game.issueCommand(u, { kind: 'stop' });
      return;
    }
    if (kind === 'attack-move') {
      // Arm the primer — the next left-click on the map is the target.
      input.pendingCommand = 'attackMove';
      canvas.classList.add('priming');
      game.notify('Attack-move: click a target location. (Esc to cancel)');
      return;
    }
    if (kind === 'patrol' || kind === 'move') {
      game.notify(`Right-click a target / location. (${kind})`);
      return;
    }
    // Resource gather actions: auto-target the nearest matching resource per unit.
    const resKind = kind === 'gather-wood' ? 'wood'
      : kind === 'gather-food' ? 'food'
      : kind === 'gather-gold' ? 'gold'
      : 'stone';
    const resType = resKind === 'wood' ? 'tree'
      : resKind === 'food' ? 'berry_bush'
      : resKind === 'gold' ? 'gold_vein'
      : 'stone_vein';
    for (const u of units) {
      if (u.typeId !== 'villager') continue;
      // Find nearest node of that resource.
      let best: any = null, bestD = Infinity;
      for (const ent of game.entities.values()) {
        if (ent.kind !== 'resource' || ent.dead) continue;
        if (ent.typeId !== resType) continue;
        if ((ent.resourceRemaining ?? 0) <= 0) continue;
        const d = Math.hypot(ent.pos.x - u.pos.x, ent.pos.y - u.pos.y);
        if (d < bestD) { best = ent; bestD = d; }
      }
      if (best) game.issueCommand(u, { kind: 'gather', targetId: best.id });
      else game.notify(`No ${resKind} found.`);
    }
  };
}

// The top-right bar is gone; the system buttons live in the bottom-bar's
// rightmost column now. HUD emits onSystemButton when the user clicks them.
hud.onSystemButton = (kind) => {
  if (kind === 'help') help.toggle();
  else if (kind === 'settings') settings.toggle();
  else if (kind === 'audio') {
    const m = toggleMuted();
    const btn = document.getElementById('sys-audio');
    if (btn) btn.classList.toggle('off', m);
  }
};

settings.onChange = (s: SettingsState) => {
  speedMultiplier = s.speed;
  setMuted(s.audioMuted);
  if (game) game.fogEnabled = s.fogEnabled;
};
settings.onReplayTutorial = () => {
  if (tutorial) tutorial.reopen();
  settings.close();
};

function toggleHelp() { help.toggle(); }

// Active ability cast state. Set by an ability button click; consumed by the
// next left-click on the canvas. Cancel with Esc or right-click.
type PendingCast = { caster: import('@/core/types').Entity; abilityId: string } | null;
let pendingCast: PendingCast = null;

attachInput(canvas, gameRef, camera, input, (ev) => {
  if (ev.kind === 'toggle-build-menu') hud.toggleBuildMenu();
  else if (ev.kind === 'toggle-minimap') minimap?.toggle();
  else if (ev.kind === 'toggle-help') help.toggle();
  else if (ev.kind === 'toggle-pause') { paused = !paused; }
  else if (ev.kind === 'placement-end') {}
  else if (ev.kind === 'world-click') {
    // Left-click on the world while a cast is pending → fire the ability.
    if (pendingCast) {
      const target = ev['worldPos'] as { x: number; y: number };
      const r = game.castAbility(pendingCast.caster, pendingCast.abilityId, target);
      if (!r.ok) game.notify(r.reason ?? 'Cannot cast');
      pendingCast = null;
      canvas.classList.remove('casting');
    }
  } else if (ev.kind === 'cancel-cast') {
    if (pendingCast) {
      pendingCast = null;
      canvas.classList.remove('casting');
      game.notify('Cast cancelled.');
    }
  }
});

// Hero-ability hotkeys come from the mission definition (Bala Kanda:
// Q = Rama Brahmastra, E = Lakshmana Indrastra).
window.addEventListener('keydown', (e) => {
  if (!running || paused) return; // not on title screen / pause menu
  const heroDef = currentMission.heroes.find(h => h.hotkey === e.key.toLowerCase());
  if (!heroDef) return;
  // Prefer a selected hero of the matching type, else the first on the map.
  let hero = null as import('@/core/types').Entity | null;
  for (const id of game.selectedIds) {
    const ent = game.entities.get(id);
    if (ent?.typeId === heroDef.typeId && !ent.dead) { hero = ent; break; }
  }
  if (!hero) {
    for (const ent of game.entities.values()) {
      if (ent.typeId === heroDef.typeId && !ent.dead) { hero = ent; break; }
    }
  }
  if (!hero) return;
  pendingCast = { caster: hero, abilityId: heroDef.abilityId };
  canvas.classList.add('casting');
  game.notify(`Click to target ${ABILITY_DEFS_FULL[heroDef.abilityId]?.name ?? heroDef.abilityId} (Esc to cancel)`);
});

// Inline import for tooltip text — `ABILITY_DEFS` is the canonical config.
import { ABILITY_DEFS as ABILITY_DEFS_FULL } from '@/config/abilities';
bindHud();

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!help.open && !settings.open) return;
    help.close();
    settings.close();
  }
});

function frame(ts: number) {
  if (HEADLESS) { requestAnimationFrame(frame); return; }
  if (!running) { requestAnimationFrame(frame); return; }
  if (!lastFrame) lastFrame = ts;
  const dtMs = ts - lastFrame;
  lastFrame = ts;
  // When paused, don't advance sim but still render.
  let dt = paused ? 0 : (dtMs / 1000) * speedMultiplier;
  if (dt > 0.25) dt = 0.25;

  if (!paused) {
    camera.update(dt / Math.max(0.0001, speedMultiplier), input.keys, input.mouseScreen.x, input.mouseScreen.y,
      !game.pendingPlacement && settings.state.edgePan);
    simAccumulator += dt;
    while (simAccumulator >= SIM_DT) {
      game.tick(SIM_DT);
      simAccumulator -= SIM_DT;
    }
  } else {
    camera.update((dtMs / 1000), input.keys, input.mouseScreen.x, input.mouseScreen.y,
      !game.pendingPlacement && settings.state.edgePan);
  }

  render({
    game,
    camera,
    ctx,
    mouseScreen: input.mouseScreen,
    mouseWorld: input.mouseWorld,
    dragStartScreen: input.dragStartScreen,
    dragging: input.dragging,
    hoveredEntity: input.hoveredEntity,
  });

  hud.update();
  minimap?.update();
  if (tutorial && !paused) tutorial.tick(game.simTime);
  if (autoplayer && !paused) autoplayer.tick(game.simTime);
  checkEndState();
  updateMusicState();
  requestAnimationFrame(frame);
}

// Derive the music state from the current game state. Boss music when Tataka
// is alive; combat when any enemy is within sight of the player base; tension
// when a wave just spawned; peaceful otherwise.
let _lastMusicCheckAt = 0;
function updateMusicState() {
  if (HEADLESS) return;
  if (game.simTime - _lastMusicCheckAt < 1.0) return;
  _lastMusicCheckAt = game.simTime;
  if (game.outcome === 'won') { setMusicState('victory'); return; }
  if (game.outcome === 'lost') { setMusicState('defeat'); return; }
  let bossAlive = false;
  let combat = false;
  let waveActive = false;
  // Find the player's anchor building to scope "combat" range.
  let anchor = { x: 1280, y: 944 };
  for (const e of game.entities.values()) {
    if (e.owner === 1 && e.kind === 'building' && currentMission.anchorTypeIds.includes(e.typeId)) {
      anchor = { x: e.pos.x, y: e.pos.y };
      break;
    }
  }
  for (const e of game.entities.values()) {
    if (e.dead) continue;
    if (BOSS_TYPE_IDS.has(e.typeId)) { bossAlive = true; break; }
  }
  if (!bossAlive) {
    for (const e of game.entities.values()) {
      if (e.dead || e.kind !== 'unit') continue;
      if (e.owner !== 2) continue;
      const dx = e.pos.x - anchor.x, dy = e.pos.y - anchor.y;
      if (dx * dx + dy * dy < 700 * 700) { combat = true; }
      waveActive = true;
    }
  }
  setMusicState(bossAlive ? 'boss' : combat ? 'combat' : waveActive ? 'tension' : 'peaceful');
}
requestAnimationFrame(frame);

if (HEADLESS) {
  document.body.style.background = '#000';
  document.body.innerHTML = `
    <div style="color:#aaa; font-family: monospace; padding: 20px;">
      Ramayana RTS — Headless mode<br/>
      Use window.rts.api to control the game.<br/>
      Call window.rts.start() to begin.
    </div>`;
  setInterval(() => {
    if (!running || paused) return;
    for (let i = 0; i < 5; i++) game.tick(SIM_DT);
  }, 16);
}

// Boss typeIds that flip the music into boss mode.
const BOSS_TYPE_IDS = new Set(['tataka', 'subahu', 'khara', 'dushana', 'trisiras', 'kumbhakarna', 'indrajit', 'ravana', 'prahasta']);

let lastShownOutcome: 'playing' | 'won' | 'lost' = 'playing';
function checkEndState() {
  if (game.outcome === lastShownOutcome) return;
  lastShownOutcome = game.outcome;
  if (HEADLESS) return;
  endOverlay.classList.remove('victory', 'defeat');
  const comingNext = document.getElementById('coming-next');
  if (game.outcome === 'won') {
    markMissionCompleted(currentMission.id);
    endTitle.textContent = 'Victory';
    endText.innerHTML = currentMission.victoryText(game);
    endOverlay.classList.add('victory');
    endOverlay.classList.remove('hidden');
    comingNext?.classList.remove('hidden');
    refreshNextChapterButton();
    // (Victory sting comes from the music-state change — don't double it.)
  } else if (game.outcome === 'lost') {
    endTitle.textContent = 'Defeat';
    endText.innerHTML = currentMission.defeatText(game);
    endOverlay.classList.add('defeat');
    endOverlay.classList.remove('hidden');
    comingNext?.classList.add('hidden');
    Sfx.defeat();
  }
}

/** After a win, offer the next unlocked mission directly on the end screen. */
function refreshNextChapterButton() {
  const btn = document.getElementById('next-chapter-btn') as HTMLButtonElement | null;
  if (!btn) return;
  const idx = MISSIONS.findIndex(m => m.id === currentMission.id);
  const next = MISSIONS[idx + 1];
  if (next && missionUnlocked(next)) {
    btn.textContent = `Next Chapter: ${next.chapter}`;
    btn.classList.remove('hidden');
    btn.onclick = () => {
      Sfx.click();
      currentMission = next;
      maybePlayIntroThen(() => actuallyStart());
    };
  } else {
    btn.classList.add('hidden');
  }
}

if (!HEADLESS) preloadSprites();

function actuallyStart() {
  newGame();
  overlay.classList.add('hidden');
  endOverlay.classList.add('hidden');
  lastShownOutcome = 'playing';
  running = true;
  lastFrame = 0;
  // Reset per-session music bookkeeping — sim time restarts from 0, and the
  // throttle timestamp / victory state must not leak across runs.
  _lastMusicCheckAt = 0;
  setMusicState('peaceful');
}

// ===== Save / load (snapshot) =====

function quickSave() {
  if (!running || game.outcome !== 'playing') return;
  try {
    saveToSlot(game, 'quick');
    game.notify('Game saved.');
    Sfx.click();
  } catch (err) {
    console.warn('save failed', err);
    game.notify('Save failed.');
  }
}

function quickLoad(): boolean {
  const data = loadFromSlot('quick');
  if (!data) {
    if (running) game.notify('No saved game.');
    return false;
  }
  const mission = getMission(data.missionId);
  if (!mission) {
    console.warn(`save references unknown mission ${data.missionId}`);
    return false;
  }
  currentMission = mission;
  // Swap in the restored Game with the same rewiring ritual as newGame().
  game = deserializeGame(data, mission);
  gameRef.current = game;
  game.fogEnabled = settings.state.fogEnabled;
  Object.assign(api, createAgentApi({
    get game() { return game; },
    setSpeedMultiplier: runner.setSpeedMultiplier,
    setPaused: runner.setPaused,
    manualStep: runner.manualStep,
  }));
  hud.setGame(game);
  bindHud();
  minimap = new MiniMap(bbMinimap, {
    game,
    camera,
    size: 144,
    onJumpTo: (wx, wy) => camera.centerOn({ x: wx, y: wy }),
  });
  tutorial = null; // no tutorial replay mid-save
  const anchorEnt = Array.from(game.entities.values()).find(
    e => e.kind === 'building' && e.owner === 1 && currentMission.anchorTypeIds.includes(e.typeId));
  autoplayer = new AutoPlayer({ api, anchorPos: anchorEnt ? { ...anchorEnt.pos } : { x: 1280, y: 960 } });
  autoplayer.enabled = AUTOPILOT;
  if (anchorEnt) camera.centerOn(anchorEnt.pos);
  overlay.classList.add('hidden');
  endOverlay.classList.add('hidden');
  missionSelectOverlay?.classList.add('hidden');
  closePauseMenuRef?.();
  // Clear any pending ability cast — its caster belonged to the discarded Game.
  pendingCast = null;
  canvas.classList.remove('casting', 'priming');
  input.pendingCommand = null;
  lastShownOutcome = 'playing';
  _lastMusicCheckAt = 0;
  running = true;
  lastFrame = 0;
  game.notify('Game loaded.');
  requestAnimationFrame(resize);
  return true;
}

// F5 quicksave / F9 quickload.
window.addEventListener('keydown', (e) => {
  if (e.key === 'F5') { e.preventDefault(); quickSave(); }
  else if (e.key === 'F9') { e.preventDefault(); quickLoad(); }
});

/** Set by the pause-menu block so quickLoad can close it. */
let closePauseMenuRef: (() => void) | null = null;

/** Play the current mission's intro cutscene once per mission, then run cb. */
function maybePlayIntroThen(cb: () => void) {
  const introKey = `rts-intro-seen-${currentMission.id}`;
  const introShown = localStorage.getItem(introKey) === '1'
    // Migrate the pre-campaign flag so returning players don't re-watch.
    || (currentMission.id === 'bala-kanda' && localStorage.getItem('rts-intro-seen') === '1');
  if (currentMission.cutsceneIds?.length && !introShown && !SKIP_INTRO) {
    overlay.classList.add('hidden');
    missionSelectOverlay?.classList.add('hidden');
    cutscene.onComplete = () => {
      localStorage.setItem(introKey, '1');
      cb();
    };
    cutscene.play();
  } else {
    cb();
  }
}

// ===== Mission select =====
const missionSelectOverlay = document.getElementById('mission-select');
const missionGrid = document.getElementById('mission-grid');

function openMissionSelect() {
  if (!missionSelectOverlay || !missionGrid) {
    // Fallback: no select UI in the DOM — start the current mission directly.
    maybePlayIntroThen(() => actuallyStart());
    return;
  }
  missionGrid.innerHTML = '';
  const done = campaignProgress().completed;
  for (const m of MISSIONS) {
    const unlocked = missionUnlocked(m);
    const completed = done.includes(m.id);
    const card = document.createElement('button');
    card.className = 'mission-card' + (unlocked ? '' : ' locked') + (completed ? ' completed' : '');
    card.innerHTML = `
      <img src="${asset(`sprites/${m.teaserKey}.webp`)}" alt="" draggable="false"/>
      <span class="mc-chapter">${m.chapter}</span>
      <span class="mc-title">${m.title}</span>
      <span class="mc-desc">${unlocked ? m.description : 'Complete the previous chapter to unlock.'}</span>
      ${completed ? '<span class="mc-badge">✓ Complete</span>' : ''}
      ${unlocked ? '' : '<span class="mc-lock">🔒</span>'}`;
    if (unlocked) {
      card.addEventListener('click', () => {
        Sfx.click();
        currentMission = m;
        missionSelectOverlay.classList.add('hidden');
        maybePlayIntroThen(() => actuallyStart());
      });
    }
    missionGrid.appendChild(card);
  }
  overlay.classList.add('hidden');
  missionSelectOverlay.classList.remove('hidden');
}

document.getElementById('mission-back')?.addEventListener('click', () => {
  Sfx.click();
  missionSelectOverlay?.classList.add('hidden');
  overlay.classList.remove('hidden');
});

startBtn.addEventListener('click', () => {
  if (!HEADLESS) {
    initAudio();
    startMusic();
    Sfx.click();
  }
  // ?mission= param (testing) or a fresh install starts directly; otherwise
  // returning players pick their chapter.
  const fresh = campaignProgress().completed.length === 0 && !params.has('mission');
  if (fresh || params.has('mission')) {
    maybePlayIntroThen(() => actuallyStart());
  } else {
    openMissionSelect();
  }
});

restartBtn.addEventListener('click', () => {
  if (!HEADLESS) Sfx.click();
  actuallyStart();
});

// ===== Title-screen menu wiring =====
document.getElementById('title-howto')?.addEventListener('click', () => { Sfx.click(); help.show(); });
document.getElementById('title-settings')?.addEventListener('click', () => { Sfx.click(); settings.show(); });
document.getElementById('title-credits')?.addEventListener('click', () => { Sfx.click(); creditsOverlay?.classList.remove('hidden'); });
document.getElementById('credits-close')?.addEventListener('click', () => { creditsOverlay?.classList.add('hidden'); });
const creditsOverlay = document.getElementById('credits-overlay');
creditsOverlay?.addEventListener('click', (e) => { if (e.target === creditsOverlay) creditsOverlay.classList.add('hidden'); });

// ===== Pause menu wiring =====
const pauseOverlay = document.getElementById('pause-overlay');
function openPauseMenu() {
  if (!running) return;
  paused = true;
  pauseOverlay?.classList.remove('hidden');
}
function closePauseMenu() {
  paused = false;
  pauseOverlay?.classList.add('hidden');
}
closePauseMenuRef = closePauseMenu;
document.getElementById('pause-resume')?.addEventListener('click', () => { Sfx.click(); closePauseMenu(); });
document.getElementById('pause-save')?.addEventListener('click', () => { quickSave(); closePauseMenu(); });
document.getElementById('pause-load')?.addEventListener('click', () => { quickLoad(); });
document.getElementById('pause-settings')?.addEventListener('click', () => { Sfx.click(); settings.show(); });
document.getElementById('pause-howto')?.addEventListener('click', () => { Sfx.click(); help.show(); });
document.getElementById('pause-to-title')?.addEventListener('click', () => {
  Sfx.click();
  running = false;
  closePauseMenu();
  overlay.classList.remove('hidden');
});
document.getElementById('end-to-title')?.addEventListener('click', () => {
  Sfx.click();
  running = false;
  endOverlay.classList.add('hidden');
  overlay.classList.remove('hidden');
});

// Esc opens the pause menu when in-game.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (game.pendingPlacement) return;          // Esc closes placement first
  if (help.open || settings.open) return;     // Those handle Esc themselves
  if (overlay.classList.contains('hidden') && endOverlay.classList.contains('hidden')) {
    if (pauseOverlay?.classList.contains('hidden')) openPauseMenu();
    else closePauseMenu();
  }
});

const runner = {
  game,
  setSpeedMultiplier: (m: number) => { speedMultiplier = Math.max(0.1, Math.min(20, m)); },
  setPaused: (p: boolean) => { paused = p; },
  manualStep: (dt: number) => { game.tick(dt); },
};
const api = createAgentApi({
  get game() { return game; },
  setSpeedMultiplier: runner.setSpeedMultiplier,
  setPaused: runner.setPaused,
  manualStep: runner.manualStep,
});
(window as any).rts = {
  get game() { return game; },
  get camera() { return camera; },
  api,
  start: () => { startBtn.click(); },
  quickSave,
  quickLoad,
  selectMission: (id: string) => { const m = getMission(id); if (m) currentMission = m; },
  isMuted,
  toggleMuted: () => { const m = toggleMuted(); return m; },
  replayCutscene: () => { cutscene.play(); },
  replayTutorial: () => { tutorial?.reopen(); },
};
