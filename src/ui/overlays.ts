// Help (controls reference), Settings panel, and Cutscene player.
//
// Help: a static reference of all keys + click semantics + faction overview.
// Settings: audio mute, music mute, sim speed slider, fog toggle, edge-pan
//   toggle, "Replay Tutorial" button.
// Cutscene: a sequence of full-screen story panels with painted backgrounds
//   shown before gameplay starts.

// (Settings panel emits state changes via onChange; audio wiring happens in main.ts)

import { asset } from '@/util/assets';

const CUTSCENE_KEYS = [
  'cutscene-01',
  'cutscene-02',
  'cutscene-03',
  'cutscene-04',
  'cutscene-05',
  'cutscene-06',
];

export class HelpOverlay {
  private root: HTMLElement;
  private el: HTMLElement;
  open = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.el = document.createElement('div');
    this.el.className = 'overlay help-overlay hidden';
    this.el.innerHTML = this.html();
    this.el.querySelector('.close-btn')!.addEventListener('click', () => this.close());
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    document.body.appendChild(this.el);
  }

  show() { this.open = true; this.el.classList.remove('hidden'); }
  close() { this.open = false; this.el.classList.add('hidden'); }
  toggle() { this.open ? this.close() : this.show(); }

  private html() {
    return `
    <div class="panel help-panel">
      <button class="close-btn" title="Close">×</button>
      <h1>How to Play</h1>
      <div class="help-cols">
        <div>
          <h2>Goal</h2>
          <p>Survive all <b>5 rakshasa waves</b>. The <b>Sacred Yajna</b>, sage <b>Vishwamitra</b>, and <b>Rama</b> must all survive — lose any of them and the ritual fails. <b>Tataka</b> herself leads the final wave; slay her to win.</p>
          <h2>Camera</h2>
          <ul>
            <li><b>Arrow keys / WASD</b> — pan the camera</li>
            <li><b>Mouse to screen edge</b> — pan</li>
            <li><b>H</b> — center on the Yajna</li>
            <li><b>Click the mini-map</b> — jump to that location</li>
            <li><b>M</b> — toggle mini-map</li>
          </ul>
          <h2>Selection &amp; Commands</h2>
          <ul>
            <li><b>Left-click</b> — select a unit</li>
            <li><b>Left-click drag</b> — box-select multiple units</li>
            <li><b>Right-click ground</b> — move there</li>
            <li><b>Right-click enemy</b> — attack it</li>
            <li><b>Q</b> — Rama's <b>Brahmastra</b>, then click to aim</li>
            <li><b>E</b> — Lakshmana's <b>Indrastra</b>, then click to aim</li>
            <li><b>P</b> or <b>Space</b> — pause</li>
            <li><b>Esc</b> — pause menu (also cancels an aimed astra)</li>
            <li><b>F1</b> or <b>?</b> — this help</li>
          </ul>
        </div>
        <div>
          <h2>Your Warriors</h2>
          <ul>
            <li><b>Rama</b> — master archer. <b>Q: Brahmastra</b>, a devastating piercing shot.</li>
            <li><b>Lakshmana</b> — faster, swift bow. <b>E: Indrastra</b>, a rain of arrows.</li>
            <li>Both heroes <b>regenerate out of combat</b> — chip damage heals between fights.</li>
            <li><b>Vishwamitra and the rishis</b> do not fight and are vulnerable. Keep the rakshasas off them.</li>
          </ul>
          <h2>Know Your Enemy</h2>
          <ul>
            <li><b>Rakshasa Grunt</b> — fast, weak, comes in numbers</li>
            <li><b>Asura Spear</b> — sturdy melee</li>
            <li><b>Asura Archer</b> — ranged fire from a distance</li>
            <li><b>Maricha</b> — Tataka's sly son. Fast and ranged.</li>
            <li><b>Subahu</b> — Tataka's brute son. Heavy melee.</li>
            <li><b>Tataka</b> — the rakshasi queen. <b>Enrages below half HP</b> — finish her fast.</li>
          </ul>
          <h2>Tactical Tips</h2>
          <ul>
            <li>Each wave attacks from <b>one announced direction</b> — move out and intercept ahead of the altar instead of letting the fight reach it.</li>
            <li><b>Hunt deer</b> for +60 food. Your astras cost food, so keep the larder full.</li>
            <li>Your heroes are archers — <b>kite melee enemies</b>: shoot, step back, shoot again.</li>
            <li>Wounded heroes heal when out of combat. Pull back between waves and let them recover.</li>
          </ul>
        </div>
      </div>
      <p class="help-foot">Press <b>F1</b> or <b>?</b> any time to reopen this. Press <b>Esc</b> to close.</p>
    </div>
    `;
  }
}

export interface SettingsState {
  speed: number;
  audioMuted: boolean;
  musicMuted: boolean;
  fogEnabled: boolean;
  edgePan: boolean;
}

export class SettingsPanel {
  private el: HTMLElement;
  open = false;
  state: SettingsState = {
    speed: 1,
    audioMuted: false,
    musicMuted: false,
    fogEnabled: true,
    edgePan: true,
  };

  onChange: (s: SettingsState) => void = () => {};
  onReplayTutorial: () => void = () => {};

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'overlay settings-overlay hidden';
    document.body.appendChild(this.el);
    this.render();
  }

  show() { this.open = true; this.el.classList.remove('hidden'); }
  close() { this.open = false; this.el.classList.add('hidden'); }
  toggle() { this.open ? this.close() : this.show(); }

  private render() {
    this.el.innerHTML = `
      <div class="panel settings-panel">
        <button class="close-btn" title="Close">×</button>
        <h1>Settings</h1>
        <div class="setting-row">
          <label>Game Speed</label>
          <div class="setting-control">
            <input type="range" min="0.5" max="6" step="0.5" value="${this.state.speed}" class="set-speed" />
            <span class="set-speed-val">${this.state.speed.toFixed(1)}×</span>
          </div>
        </div>
        <div class="setting-row">
          <label>Audio</label>
          <button class="set-audio ${this.state.audioMuted ? 'off' : 'on'}">${this.state.audioMuted ? 'Off' : 'On'}</button>
        </div>
        <div class="setting-row">
          <label>Music</label>
          <button class="set-music ${this.state.musicMuted ? 'off' : 'on'}">${this.state.musicMuted ? 'Off' : 'On'}</button>
        </div>
        <div class="setting-row">
          <label>Fog of War</label>
          <button class="set-fog ${this.state.fogEnabled ? 'on' : 'off'}">${this.state.fogEnabled ? 'On' : 'Off'}</button>
        </div>
        <div class="setting-row">
          <label>Edge-Scroll Camera</label>
          <button class="set-edgepan ${this.state.edgePan ? 'on' : 'off'}">${this.state.edgePan ? 'On' : 'Off'}</button>
        </div>
        <div class="setting-row">
          <label>Tutorial</label>
          <button class="set-replay-tutorial">Replay</button>
        </div>
        <p class="help-foot">Press <b>Esc</b> to close.</p>
      </div>
    `;
    const $ = (sel: string) => this.el.querySelector(sel) as HTMLElement;
    $('.close-btn').addEventListener('click', () => this.close());
    this.el.addEventListener('click', (e) => { if (e.target === this.el) this.close(); });

    const speedInput = $('.set-speed') as HTMLInputElement;
    const speedVal = $('.set-speed-val');
    speedInput.addEventListener('input', () => {
      this.state.speed = parseFloat(speedInput.value);
      speedVal.textContent = `${this.state.speed.toFixed(1)}×`;
      this.onChange(this.state);
    });

    const toggleBtn = (sel: string, key: keyof SettingsState) => {
      $(sel).addEventListener('click', () => {
        const cur = this.state[key] as boolean;
        (this.state[key] as any) = !cur;
        this.render();
        this.onChange(this.state);
      });
    };
    toggleBtn('.set-audio', 'audioMuted');
    toggleBtn('.set-music', 'musicMuted');
    toggleBtn('.set-fog', 'fogEnabled');
    toggleBtn('.set-edgepan', 'edgePan');
    $('.set-replay-tutorial').addEventListener('click', () => this.onReplayTutorial());
  }
}

interface CutscenePanel { id: string; narration?: string; caption?: string; }

export class CutscenePlayer {
  private el: HTMLElement;
  private currentIdx = 0;
  open = false;
  private panels: CutscenePanel[] = CUTSCENE_KEYS.map(id => ({ id }));
  // Panels parsed from /story.json once the fetch lands. Applied to
  // `this.panels` only at the start of a playback — never mid-playback.
  private loadedPanels: CutscenePanel[] | null = null;
  private storyLoad: Promise<void>;
  onComplete: () => void = () => {};

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'cutscene-overlay hidden';
    document.body.appendChild(this.el);
    // Kick off the narration load (GPT-generated story). play() awaits this
    // (with a timeout fallback) so panels never appear without narration.
    this.storyLoad = fetch(asset('story.json'))
      .then(r => (r.ok ? r.json() : null))
      .then((data: any) => {
        if (data && Array.isArray(data.panels)) {
          this.loadedPanels = data.panels.map((p: any) => ({
            id: p.id, narration: p.narration, caption: p.caption,
          }));
        }
      })
      .catch(() => {});
  }

  async play() {
    // Show the black overlay immediately so there's no gameplay flash while
    // the story loads.
    this.open = true;
    this.currentIdx = 0;
    this.el.innerHTML = '';
    this.el.classList.remove('hidden');
    // Wait for the narration fetch, but no longer than ~1.5s — after that,
    // fall back to whatever we have (built-in panel list without narration).
    if (!this.loadedPanels) {
      await Promise.race([
        this.storyLoad,
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]);
    }
    if (!this.open) return; // cancelled while waiting
    if (this.loadedPanels) this.panels = this.loadedPanels;
    this.render();
  }

  private render() {
    if (this.currentIdx >= this.panels.length) { this.finish(); return; }
    const panel = this.panels[this.currentIdx];
    const isLast = this.currentIdx === this.panels.length - 1;
    const narr = panel.narration ? `<div class="cutscene-narration">${escapeHtml(panel.narration)}</div>` : '';
    this.el.innerHTML = `
      <img class="cutscene-image" src="${asset(`sprites/${panel.id}.webp`)}" alt="" />
      ${narr}
      <div class="cutscene-controls">
        <button class="cutscene-skip">Skip ▶</button>
        <div class="cutscene-progress">${this.currentIdx + 1} / ${this.panels.length}</div>
        <button class="cutscene-next">${isLast ? 'Begin' : 'Next →'}</button>
      </div>
    `;
    this.el.querySelector('.cutscene-skip')!.addEventListener('click', () => this.finish());
    this.el.querySelector('.cutscene-next')!.addEventListener('click', () => this.advance());
  }

  private advance() {
    this.currentIdx++;
    if (this.currentIdx >= this.panels.length) {
      this.finish();
    } else {
      this.render();
    }
  }

  private finish() {
    this.open = false;
    this.el.classList.add('hidden');
    this.onComplete();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
