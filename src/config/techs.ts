// Tech tree ("Blessings"). Researched at buildings through the normal
// production queue (ProductionOrder kind 'tech').
//
// Effects are applied PER PLAYER: on completion they are stamped onto all
// matching live entities and onto future spawns (Game.applyTechToEntity).
// Defs are never mutated — both factions share UNIT_DEFS/BUILDING_DEFS.

import type { ResourceBag } from '@/core/types';
import type { Game } from '@/core/game';

export interface TechEffect {
  /** Explicit unit/building typeIds this effect touches. */
  targetTypeIds?: string[];
  /** Or a class shorthand (resolved in Game.techEffectMatches). */
  targetClass?: 'military' | 'villager' | 'hero' | 'tower' | 'building';
  stat: 'attackDmg' | 'armor' | 'speed' | 'gatherRate' | 'buildSpeed' | 'attackRange' | 'maxHp';
  add?: number;
  mul?: number;
}

export interface TechDef {
  id: string;
  name: string;
  description: string;
  /** Building typeIds whose action panel offers this research. */
  hostBuildings: string[];
  cost: Partial<ResourceBag>;
  researchTime: number;      // seconds
  requires?: string[];       // other tech ids
  effects: TechEffect[];
  /** One-shot script on completion (e.g. Sanjivani instant heal). */
  onComplete?: (game: Game, owner: number) => void;
  iconKey?: string;
}

export const TECH_DEFS: Record<string, TechDef> = {
  bala_mantra: {
    id: 'bala_mantra',
    name: 'Bala Mantra',
    description: "Vishwamitra's mantra banishes fatigue. Villagers gather 20% faster.",
    hostBuildings: ['town_center', 'hermitage'],
    cost: { food: 75, gold: 50 },
    researchTime: 30,
    effects: [{ targetClass: 'villager', stat: 'gatherRate', mul: 1.2 }],
  },
  atibala_mantra: {
    id: 'atibala_mantra',
    name: 'Atibala Mantra',
    description: 'The greater mantra. Villagers build 25% faster and gain +10 hp.',
    hostBuildings: ['town_center', 'hermitage'],
    cost: { food: 150, gold: 100 },
    researchTime: 40,
    requires: ['bala_mantra'],
    effects: [
      { targetClass: 'villager', stat: 'buildSpeed', mul: 1.25 },
      { targetClass: 'villager', stat: 'maxHp', add: 10 },
    ],
  },
  sabaris_offering: {
    id: 'sabaris_offering',
    name: "Sabari's Offering",
    description: 'The devotee shares her sweetest berries. Food gathering +25%.',
    hostBuildings: ['mill'],
    cost: { food: 75, wood: 75 },
    researchTime: 30,
    effects: [{ targetClass: 'villager', stat: 'gatherRate', mul: 1.25 }], // stacks with Bala; food-only nuance kept simple
  },
  agastyas_armory: {
    id: 'agastyas_armory',
    name: "Agastya's Armory",
    description: 'The sage gifts celestial weapons. Spearmen and cavalry +2 attack.',
    hostBuildings: ['barracks'],
    cost: { food: 100, gold: 50 },
    researchTime: 40,
    effects: [{ targetTypeIds: ['spearman', 'cavalry'], stat: 'attackDmg', add: 2 }],
  },
  agneyastra_tips: {
    id: 'agneyastra_tips',
    name: 'Agneyastra Tips',
    description: 'Arrowheads kissed by fire. Archers +3 attack; heroes +2 attack.',
    hostBuildings: ['archery_range'],
    cost: { wood: 100, gold: 75 },
    researchTime: 40,
    effects: [
      { targetTypeIds: ['archer'], stat: 'attackDmg', add: 3 },
      { targetClass: 'hero', stat: 'attackDmg', add: 2 },
    ],
  },
  vigil_of_jatayu: {
    id: 'vigil_of_jatayu',
    name: 'Vigil of Jatayu',
    description: 'The great eagle keeps watch. Watchtowers +2 damage and +25% range.',
    hostBuildings: ['watchtower'],
    cost: { wood: 100, stone: 75 },
    researchTime: 45,
    effects: [
      { targetClass: 'tower', stat: 'attackDmg', add: 2 },
      { targetClass: 'tower', stat: 'attackRange', mul: 1.25 },
    ],
  },
  vayus_swiftness: {
    id: 'vayus_swiftness',
    name: "Vayu's Swiftness",
    description: 'The wind god favors the riders. Cavalry +15% speed, +1 attack.',
    hostBuildings: ['stable'],
    cost: { food: 125, gold: 75 },
    researchTime: 40,
    effects: [
      { targetTypeIds: ['cavalry'], stat: 'speed', mul: 1.15 },
      { targetTypeIds: ['cavalry'], stat: 'attackDmg', add: 1 },
    ],
  },
  indras_kavacha: {
    id: 'indras_kavacha',
    name: "Indra's Kavacha",
    description: 'Celestial armor from the king of gods. All military +2 armor.',
    hostBuildings: ['barracks'],
    cost: { food: 200, gold: 150 },
    researchTime: 60,
    effects: [{ targetClass: 'military', stat: 'armor', add: 2 }],
  },
  nalas_masonry: {
    id: 'nalas_masonry',
    name: "Nala's Masonry",
    description: 'The bridge-builder strengthens your works. Buildings +30% hp.',
    hostBuildings: ['mining_camp'],
    cost: { wood: 150, stone: 100 },
    researchTime: 45,
    effects: [{ targetClass: 'building', stat: 'maxHp', mul: 1.3 }],
  },
  sanjivani_herb: {
    id: 'sanjivani_herb',
    name: 'Sanjivani Herb',
    description: 'The mountain herb that recalls life. Instantly fully heals Rama and Lakshmana.',
    hostBuildings: ['mill'],
    cost: { food: 100, gold: 100 },
    researchTime: 25,
    effects: [],
    onComplete: (game, owner) => {
      for (const e of game.entities.values()) {
        if (e.owner !== owner || e.dead) continue;
        if (e.typeId === 'rama' || e.typeId === 'lakshmana') {
          e.hp = e.maxHp;
        }
      }
      game.notify('The Sanjivani glows — the princes are made whole!');
    },
  },
};

/** All tech ids, in display order. */
export const TECH_ORDER = Object.keys(TECH_DEFS);
