// Mission framework. A mission owns everything the engine used to hardcode
// for Bala Kanda: map setup, enemy brains, win/lose rules, scripted beats,
// and the strings/art the UI shows around the sim.
//
// Rules of the framework (learned the hard way):
//   - evaluateOutcome must be a pure read over entity/game state. Anything
//     that needs memory (e.g. "did the boss ever spawn") stores it in
//     mission-owned state via tick(), or on Game fields set at spawn time.
//   - No scripted beat may gate the win without a timeout. Theater degrades
//     to a notify string; it never softlocks.

import type { Game } from '@/core/game';

export type Outcome = 'playing' | 'won' | 'lost';

export interface MissionHero {
  typeId: string;      // 'rama'
  abilityId: string;   // 'brahmastra'
  hotkey: string;      // 'q'
}

export interface MissionDef {
  id: string;                 // 'bala-kanda'
  chapter: string;            // 'Bala Kanda'
  title: string;              // 'The Sacred Fire'
  /** One-paragraph pitch for the mission-select card. */
  description: string;
  /** Sprite key for the mission-select card art (public/sprites/<key>.png). */
  teaserKey: string;
  /** Missions that must be completed before this one unlocks. */
  requires: string[];

  /** Build the map: terrain, spawns, AI controllers into game.ais. */
  load(game: Game): void;
  /** Win/lose rules, evaluated every tick after systems run. */
  evaluateOutcome(game: Game): Outcome;
  /** Optional per-tick script hook (boss phases, story beats, escalation). */
  tick?(game: Game, dt: number): void;

  /** End-screen copy. simTime is the completion time in seconds. */
  victoryText(game: Game): string;
  defeatText(game: Game): string;

  /** Heroes with castable abilities (drives HUD buttons + hotkeys). */
  heroes: MissionHero[];
  /** Building typeIds the camera/H-key treats as "home", in priority order. */
  anchorTypeIds: string[];
  /** Show the wave counter pill (WaveDirector missions). */
  showWaveCounter: boolean;
  /** Player has an economy: show full resource bar, allow build menu. */
  economyEnabled: boolean;
  /** Cutscene panel ids to play before the mission (must exist as sprites). */
  cutsceneIds?: string[];
  /** Extra mission-specific section injected into the F1 help overlay. */
  helpHtml?: string;
  /** Techs available in this mission (typeIds into TECH_DEFS); empty = none. */
  techIds?: string[];
}
