// In-game tutorial: a stepped walkthrough that teaches players who have never
// touched an RTS how to play. Each step has:
//   - a clear instruction
//   - an optional "complete-when" predicate that auto-advances when satisfied
//   - a manual "Next" button as a fallback
//   - optional spotlight area (rectangle in screen coords) — others dimmed
//
// The player can dismiss the whole tour with "Skip Tutorial". Persistent
// "tutorial-done" flag stored in localStorage so it doesn't keep appearing.

import type { Game } from '@/core/game';

const STORAGE_KEY = 'rts-tutorial-completed';

export type SpotlightId =
  | 'none'
  | 'resource-bar'
  | 'selection-panel'
  | 'build-menu'
  | 'minimap'
  | 'town-center';

export interface TutorialStep {
  id: string;
  title: string;
  body: string;
  completeWhen?: (game: Game) => boolean;
  spotlight?: SpotlightId;
}

// Tutorial steps for the Bala Kanda heroes-only demo. Only six lessons — no
// economy, no buildings to manage. The whole flow is: meet the princes,
// understand the goal, learn abilities, hunt for food, brace for waves.
export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'welcome',
    title: 'Welcome, Defender',
    body: `Sage <b>Vishwamitra</b> has called the young princes <b>Rama</b> and <b>Lakshmana</b> into the forest of Dandaka to protect his sacred Yajna fire from the rakshasi <b>Tataka</b> and her demon sons.<br/><br/>You command both princes. Five rakshasa waves will come. Tataka herself leads the last.`,
  },
  {
    id: 'camera',
    title: 'Survey the Battlefield',
    body: `Drag with the <b>middle mouse button</b> to pan the map. Or push your mouse to the screen edge / use <b>WASD</b> / arrow keys. Press <b>H</b> any time to recenter on the Yajna. The <b>mini-map</b> in the bottom-right shows the whole forest.`,
  },
  {
    id: 'select-rama',
    title: 'Select Rama',
    body: `<b>Left-click</b> on <b>Rama</b> — he's the prince in deep blue beside the altar. You'll see a glowing gold ring around him and his portrait will fill the bottom-left panel. His arrow has long range and high damage.`,
    completeWhen: (g) => {
      for (const id of g.selectedIds) {
        const e = g.entities.get(id);
        if (e?.kind === 'unit' && e.typeId === 'rama') return true;
      }
      return false;
    },
  },
  {
    id: 'position',
    title: 'Position Your Heroes',
    body: `Drag a <b>box around both princes</b> to select them together, then <b>right-click</b> a spot near the Yajna. They'll fan into formation. Heroes auto-engage any rakshasa within sight — but positioning between the demons and the rishis matters.`,
  },
  {
    id: 'hunt-deer',
    title: 'Hunt for Food',
    body: `Deer wander the forest. Right-click on one with a hero selected; killing one gives <b>+60 food</b>. Food is your <b>ability fuel</b> — the Brahmastra costs 30 food, the Indrastra 20. Hunt early so you have it ready when the bosses arrive.`,
    completeWhen: (g) => g.resources[1].food >= 260,
  },
  {
    id: 'brahmastra',
    title: "Rama's Brahmastra (Q)",
    body: `Rama wields the divine arrow — the <b>Brahmastra</b>. With Rama selected, click the glowing ability button (or press <b>Q</b>), then click a target spot. The arrow pierces a straight line for 120 damage to every demon it touches. <b>60-second cooldown.</b><br/><br/>Lakshmana has the <b>Indrastra</b> (E) — single-target stun, 45s cooldown.<br/><br/><b>Save them for the bosses: Maricha, Subahu, and finally Tataka.</b>`,
  },
  {
    id: 'goal',
    title: 'Defend the Yajna',
    body: `<b>Win:</b> survive every wave and defeat <b>Tataka</b> in single combat.<br/><b>Lose:</b> the Yajna's flame is extinguished, Vishwamitra falls, or Rama falls.<br/><br/>Press <b>Esc</b> for the pause menu. <b>F1</b> for the full controls reference.<br/><br/><b>Jai Shri Ram.</b>`,
  },
];

export class TutorialManager {
  private root: HTMLElement;
  private panel: HTMLElement;
  private currentIdx = 0;
  private completed = false;
  private game: Game;
  // Last predicate check time so we don't run them too often.
  private lastCheckAt = 0;

  onComplete: () => void = () => {};

  constructor(root: HTMLElement, game: Game) {
    this.root = root;
    this.game = game;

    this.panel = document.createElement('div');
    this.panel.className = 'tutorial';
    this.root.appendChild(this.panel);

    if (localStorage.getItem(STORAGE_KEY) === '1') {
      this.completed = true;
      this.panel.style.display = 'none';
    } else {
      this.render();
    }
  }

  setGame(game: Game) {
    this.game = game;
  }

  tick(now: number) {
    if (this.completed) return;
    if (now - this.lastCheckAt < 0.25) return;
    this.lastCheckAt = now;
    const step = TUTORIAL_STEPS[this.currentIdx];
    if (step?.completeWhen && step.completeWhen(this.game)) {
      this.advance();
    }
  }

  advance() {
    if (this.completed) return;
    this.currentIdx++;
    if (this.currentIdx >= TUTORIAL_STEPS.length) {
      this.complete();
      return;
    }
    this.render();
  }

  back() {
    if (this.currentIdx > 0) {
      this.currentIdx--;
      this.render();
    }
  }

  skip() {
    this.complete();
  }

  reopen() {
    this.completed = false;
    this.currentIdx = 0;
    this.panel.style.display = '';
    this.render();
    localStorage.removeItem(STORAGE_KEY);
  }

  private complete() {
    this.completed = true;
    this.panel.style.display = 'none';
    localStorage.setItem(STORAGE_KEY, '1');
    this.onComplete();
  }

  private render() {
    const step = TUTORIAL_STEPS[this.currentIdx];
    if (!step) return;
    const progress = `${this.currentIdx + 1} / ${TUTORIAL_STEPS.length}`;
    const isFirst = this.currentIdx === 0;
    const isLast = this.currentIdx === TUTORIAL_STEPS.length - 1;
    this.panel.innerHTML = `
      <div class="tut-header">
        <div class="tut-progress">Lesson ${progress}</div>
        <button class="tut-skip" title="Skip the tutorial">Skip ▶</button>
      </div>
      <div class="tut-title">${step.title}</div>
      <div class="tut-body">${step.body}</div>
      <div class="tut-actions">
        <button class="tut-prev" ${isFirst ? 'disabled' : ''}>← Back</button>
        <button class="tut-next">${isLast ? 'Begin Play' : 'Next →'}</button>
      </div>
    `;
    this.panel.querySelector('.tut-skip')!.addEventListener('click', () => this.skip());
    this.panel.querySelector('.tut-prev')!.addEventListener('click', () => this.back());
    this.panel.querySelector('.tut-next')!.addEventListener('click', () => this.advance());
  }
}
