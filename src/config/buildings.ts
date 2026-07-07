// Building definitions. Player faction = Ayodhya; enemy faction = Lanka.
// Both share the same tech tree but mirror buildings (separate typeIds so the
// AI can train enemy-tagged units that the bonus-damage system reads).

import type { ResourceBag, ResourceKind } from '@/core/types';

export interface BuildingDef {
  typeId: string;
  name: string;
  // Optional Sanskrit / themed name shown as a subtitle. Plain `name` is the
  // primary user-facing label so new players aren't lost.
  themedName?: string;
  description: string;
  sizeTiles: { w: number; h: number };
  hp: number;
  cost: Partial<ResourceBag>;
  buildTime: number;
  isDropoff?: boolean;
  acceptedResources?: ResourceKind[];
  providesPop?: number;
  trains?: string[];
  // Fog-of-war vision radius in tiles. Omitted → fog default (6 for buildings).
  sightRange?: number;
  /** Draw with another building typeId's sprite (mission buildings reuse art). */
  spriteBase?: string;
  // Visual + faction.
  primaryColor: string;
  roofColor: string;
  accentColor: string;
  attack?: {
    dmg: number;
    range: number;
    rate: number; // attacks per second
  };
}

const buildAyodhya = (extra: Partial<BuildingDef>): BuildingDef =>
  ({ primaryColor: '#c2a36e', roofColor: '#9b3a3a', accentColor: '#f0c850' } as BuildingDef);

export const BUILDING_DEFS: Record<string, BuildingDef> = {
  // ===== Ayodhya (player) =====
  town_center: {
    typeId: 'town_center',
    name: 'Town Center',
    themedName: 'Ashram',
    description: 'Heart of your settlement. Trains villagers, accepts all resources.',
    sizeTiles: { w: 4, h: 4 },
    hp: 1600,
    cost: { wood: 275 },
    buildTime: 80,
    isDropoff: true,
    acceptedResources: ['wood', 'food', 'gold', 'stone'],
    providesPop: 5,
    trains: ['villager'],
    sightRange: 8,
    primaryColor: '#c8a875',
    roofColor: '#a04030',
    accentColor: '#f0c850',
  },
  house: {
    typeId: 'house',
    name: 'House',
    themedName: 'Kutira',
    description: 'A simple dwelling. Increases your population cap by 5.',
    sizeTiles: { w: 2, h: 2 },
    hp: 250,
    cost: { wood: 30 },
    buildTime: 12,
    providesPop: 5,
    primaryColor: '#b48a5a',
    roofColor: '#6b3a22',
    accentColor: '#d8b890',
  },
  lumber_camp: {
    typeId: 'lumber_camp',
    name: 'Lumber Camp',
    themedName: 'Vana Shibira',
    description: 'Forward camp for processing wood. Place near forests.',
    sizeTiles: { w: 2, h: 2 },
    hp: 350,
    cost: { wood: 100 },
    buildTime: 25,
    isDropoff: true,
    acceptedResources: ['wood'],
    primaryColor: '#8b5a2b',
    roofColor: '#4a2a14',
    accentColor: '#b88a4a',
  },
  mill: {
    typeId: 'mill',
    name: 'Mill',
    themedName: 'Anna Shala',
    description: 'Processes food. Place near berry bushes or farms.',
    sizeTiles: { w: 2, h: 2 },
    hp: 350,
    cost: { wood: 100 },
    buildTime: 25,
    isDropoff: true,
    acceptedResources: ['food'],
    primaryColor: '#d4a060',
    roofColor: '#7a4030',
    accentColor: '#f0c060',
  },
  mining_camp: {
    typeId: 'mining_camp',
    name: 'Mining Camp',
    themedName: 'Khani Shibira',
    description: 'Processes stone and gold. Place near veins.',
    sizeTiles: { w: 2, h: 2 },
    hp: 350,
    cost: { wood: 100 },
    buildTime: 25,
    isDropoff: true,
    acceptedResources: ['gold', 'stone'],
    primaryColor: '#9aa4ae',
    roofColor: '#404a54',
    accentColor: '#c0c8d0',
  },
  barracks: {
    typeId: 'barracks',
    name: 'Barracks',
    themedName: 'Senapati Bhavana',
    description: 'Trains spear infantry.',
    sizeTiles: { w: 3, h: 3 },
    hp: 700,
    cost: { wood: 175 },
    buildTime: 50,
    trains: ['spearman'],
    primaryColor: '#a87850',
    roofColor: '#5a2a1a',
    accentColor: '#e0b070',
  },
  archery_range: {
    typeId: 'archery_range',
    name: 'Archery Range',
    themedName: 'Dhanus Shala',
    description: 'Trains archers.',
    sizeTiles: { w: 3, h: 3 },
    hp: 700,
    cost: { wood: 175 },
    buildTime: 50,
    trains: ['archer'],
    primaryColor: '#b08858',
    roofColor: '#4a3020',
    accentColor: '#d8c090',
  },
  stable: {
    typeId: 'stable',
    name: 'Ashva Shala',
    description: 'Trains cavalry.',
    sizeTiles: { w: 3, h: 3 },
    hp: 700,
    cost: { wood: 175 },
    buildTime: 50,
    trains: ['cavalry'],
    primaryColor: '#a06850',
    roofColor: '#5a3020',
    accentColor: '#e0a060',
  },
  watchtower: {
    typeId: 'watchtower',
    name: 'Watchtower',
    themedName: 'Tarana Stambha',
    description: 'Defensive tower. Shoots arrows at enemies in range.',
    sizeTiles: { w: 2, h: 2 },
    hp: 500,
    cost: { wood: 50, stone: 100 },
    buildTime: 35,
    sightRange: 9,
    primaryColor: '#aab4be',
    roofColor: '#5a6470',
    accentColor: '#d8d4c0',
    attack: { dmg: 7, range: 140, rate: 1.2 },
  },

  wall: {
    typeId: 'wall',
    name: 'Stone Wall',
    themedName: 'Prakara',
    description: 'A stone barrier that blocks rakshasas. Drag to raise a line of wall.',
    sizeTiles: { w: 1, h: 1 },
    hp: 350,
    cost: { stone: 10 },
    buildTime: 6,
    sightRange: 3,
    primaryColor: '#9aa4ae',
    roofColor: '#5a6470',
    accentColor: '#c8ced4',
  },
  gate: {
    typeId: 'gate',
    name: 'Gate',
    themedName: 'Dwara',
    description: 'A gate in your wall. Opens for your own units, shuts against enemies.',
    sizeTiles: { w: 1, h: 1 },
    hp: 500,
    cost: { stone: 25, wood: 15 },
    buildTime: 10,
    sightRange: 4,
    primaryColor: '#9aa4ae',
    roofColor: '#5a4a30',
    accentColor: '#c8ced4',
  },

  // Special Bala Kanda objective: the Yajna (sacred fire altar). Cannot be
  // player-built — placed by the scenario. Provides large sight, takes damage
  // when rakshasas attack it. If destroyed → game over.
  yajna: {
    typeId: 'yajna',
    name: 'Sacred Yajna',
    themedName: 'Yajna',
    description: "Vishwamitra's sacred fire. Defend it at all costs.",
    sizeTiles: { w: 2, h: 2 },
    hp: 800,
    cost: {},
    buildTime: 0,
    sightRange: 18,
    primaryColor: '#f0c850',
    roofColor: '#a04030',
    accentColor: '#ff9020',
  },

  // ===== Lanka (AI) =====
  town_center_enemy: {
    typeId: 'town_center_enemy',
    name: 'Lanka Citadel',
    description: 'Rakshasa stronghold.',
    sizeTiles: { w: 4, h: 4 },
    hp: 1600,
    cost: { wood: 275 },
    buildTime: 80,
    isDropoff: true,
    acceptedResources: ['wood', 'food', 'gold', 'stone'],
    providesPop: 5,
    trains: ['villager_enemy'],
    sightRange: 8,
    primaryColor: '#704030',
    roofColor: '#2a0a0a',
    accentColor: '#a04030',
  },
  house_enemy: {
    typeId: 'house_enemy', name: 'Asura Dwelling',
    description: 'Enemy housing.',
    sizeTiles: { w: 2, h: 2 }, hp: 250, cost: { wood: 30 }, buildTime: 12,
    providesPop: 5,
    primaryColor: '#5a3030', roofColor: '#1a0a0a', accentColor: '#8a4040',
  },
  lumber_camp_enemy: {
    typeId: 'lumber_camp_enemy', name: 'Enemy Lumber Camp',
    description: 'Enemy wood camp.',
    sizeTiles: { w: 2, h: 2 }, hp: 350, cost: { wood: 100 }, buildTime: 25,
    isDropoff: true, acceptedResources: ['wood'],
    primaryColor: '#5a3818', roofColor: '#2a1a08', accentColor: '#8a5828',
  },
  mill_enemy: {
    typeId: 'mill_enemy', name: 'Enemy Mill',
    description: 'Enemy food processor.',
    sizeTiles: { w: 2, h: 2 }, hp: 350, cost: { wood: 100 }, buildTime: 25,
    isDropoff: true, acceptedResources: ['food'],
    primaryColor: '#7a4030', roofColor: '#2a1a08', accentColor: '#a04040',
  },
  mining_camp_enemy: {
    typeId: 'mining_camp_enemy', name: 'Enemy Mining Camp',
    description: 'Enemy gold/stone camp.',
    sizeTiles: { w: 2, h: 2 }, hp: 350, cost: { wood: 100 }, buildTime: 25,
    isDropoff: true, acceptedResources: ['gold', 'stone'],
    primaryColor: '#5a4858', roofColor: '#1a0a1a', accentColor: '#7a6878',
  },
  barracks_enemy: {
    typeId: 'barracks_enemy', name: 'Asura Barracks',
    description: 'Trains rakshasa spear.',
    sizeTiles: { w: 3, h: 3 }, hp: 700, cost: { wood: 175 }, buildTime: 50,
    trains: ['spearman_enemy'],
    primaryColor: '#6a3030', roofColor: '#1a0a0a', accentColor: '#a04040',
  },
  archery_range_enemy: {
    typeId: 'archery_range_enemy', name: 'Asura Archery',
    description: 'Trains rakshasa archers.',
    sizeTiles: { w: 3, h: 3 }, hp: 700, cost: { wood: 175 }, buildTime: 50,
    trains: ['archer_enemy'],
    primaryColor: '#5a3050', roofColor: '#1a0a1a', accentColor: '#8a5078',
  },
  stable_enemy: {
    typeId: 'stable_enemy', name: 'Asura Stable',
    description: 'Trains rakshasa cavalry.',
    sizeTiles: { w: 3, h: 3 }, hp: 700, cost: { wood: 175 }, buildTime: 50,
    trains: ['cavalry_enemy'],
    primaryColor: '#603030', roofColor: '#1a0a0a', accentColor: '#9a4040',
  },
};

export const PLAYER_BUILDABLE = [
  'house', 'lumber_camp', 'mill', 'mining_camp',
  'barracks', 'archery_range', 'stable', 'watchtower',
  'wall', 'gate',
];
export const AI_BUILDABLE = [
  'house_enemy', 'lumber_camp_enemy', 'mill_enemy', 'mining_camp_enemy',
  'barracks_enemy', 'archery_range_enemy', 'stable_enemy',
];

// Map a building typeId to the player's faction "town center" typeId.
export function tcTypeForOwner(owner: number): string {
  return owner === 1 ? 'town_center' : 'town_center_enemy';
}
