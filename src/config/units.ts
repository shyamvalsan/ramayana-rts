// Unit definitions. Two factions: Ayodhya (player) and Lanka (AI enemy). Both
// share the same archetypes but use different names + visuals. Stats are
// tuned for a rock-paper-scissors triangle:
//   Spear  beats Cavalry
//   Cavalry beats Archer
//   Archer beats Spear

import type { ResourceBag } from '@/core/types';

export interface UnitDef {
  typeId: string;
  name: string;
  description: string;
  hp: number;
  radius: number;
  speed: number;
  // Combat (optional for civilians).
  attackDmg?: number;
  attackRange?: number;
  attackSpeed?: number;
  // Anti-class bonus damage (e.g., spear bonus vs cavalry).
  bonusVs?: { typeIds: string[]; dmg: number };
  // Armor (flat damage reduction).
  armor?: number;
  // Out-of-combat regeneration in hp/sec (heroes, sages). Applies only when
  // no enemy is within ~300px — chip damage heals between waves, focused
  // assaults still kill.
  hpRegen?: number;
  // Fog-of-war vision radius in tiles. Omitted → fog default (7 for units).
  sightRange?: number;
  // Protected VIPs (sages) you defend but don't command — excluded from
  // drag-box selection so they aren't swept into your army by accident.
  noBoxSelect?: boolean;
  // ---- Boss / reskin support (campaign bosses reuse existing sprite sets) ----
  /** Draw with another typeId's sprite set (e.g. khara borrows 'subahu'). */
  spriteBase?: string;
  /** Draw-size multiplier (1 = normal 48px unit). Bosses ~1.25-1.6. */
  sizeScale?: number;
  /** 'major' bosses get the top HP bar + big death drama; 'mid' get shakes. */
  bossTier?: 'major' | 'mid';
  /** Persistent color overlay so reskinned bosses read as distinct.
   *  MUST carry its own alpha, e.g. 'rgba(255, 215, 0, 0.35)'. */
  tintColor?: string;
  // Gathering (villager).
  gatherRate?: number;
  gatherCapacity?: number;
  canBuild?: boolean;
  // Build-from.
  trainTime: number;
  cost: Partial<ResourceBag>;
  popCost: number;
  builtAt: string[];
  // Visual.
  primaryColor: string;
  accentColor: string;
  weaponColor: string;
  ranged: boolean;
}

export const UNIT_DEFS: Record<string, UnitDef> = {
  // ---- Heroes ----
  rama: {
    typeId: 'rama',
    name: 'Rama',
    description: 'Crown prince of Ayodhya. Master archer with a piercing arrow.',
    hp: 220,
    radius: 12,
    speed: 95,
    attackDmg: 22,
    attackRange: 140,
    attackSpeed: 1.4,
    armor: 2,
    hpRegen: 3,
    sightRange: 12,
    trainTime: 0,
    cost: {},
    popCost: 0,
    builtAt: [],
    primaryColor: '#3a7fd6',
    accentColor: '#f0c850',
    weaponColor: '#a08050',
    ranged: true,
  },
  lakshmana: {
    typeId: 'lakshmana',
    name: 'Lakshmana',
    description: 'Rama’s loyal brother. Faster, slightly less durable, swift bow.',
    hp: 180,
    radius: 11,
    speed: 110,
    attackDmg: 18,
    attackRange: 120,
    attackSpeed: 1.6,
    armor: 1,
    hpRegen: 3,
    sightRange: 12,
    trainTime: 0,
    cost: {},
    popCost: 0,
    builtAt: [],
    primaryColor: '#e89a3a',
    accentColor: '#dcdcdc',
    weaponColor: '#a08050',
    ranged: true,
  },
  villager: {
    typeId: 'villager',
    name: 'Villager',
    description: 'Gathers resources and constructs buildings.',
    hp: 40,
    radius: 9,
    speed: 70,
    attackDmg: 3,
    attackRange: 16,
    attackSpeed: 1.0,
    armor: 0,
    gatherRate: 0.6,
    gatherCapacity: 10,
    canBuild: true,
    sightRange: 5,
    trainTime: 18,
    cost: { food: 50 },
    popCost: 1,
    builtAt: ['town_center'],
    primaryColor: '#9ec6f5',
    accentColor: '#f0c850',
    weaponColor: '#9b6b3a',
    ranged: false,
  },
  spearman: {
    typeId: 'spearman',
    name: 'Bhata',
    description: 'Spear infantry. Strong against cavalry.',
    hp: 60,
    radius: 10,
    speed: 80,
    attackDmg: 6,
    attackRange: 22,
    attackSpeed: 1.0,
    bonusVs: { typeIds: ['cavalry', 'cavalry_enemy'], dmg: 10 },
    armor: 1,
    trainTime: 18,
    cost: { food: 35, wood: 25 },
    popCost: 1,
    builtAt: ['barracks'],
    primaryColor: '#7892c4',
    accentColor: '#c9a23a',
    weaponColor: '#cdd1d4',
    ranged: false,
  },
  archer: {
    typeId: 'archer',
    name: 'Dhanvi',
    description: 'Ranged archer. Strong against spear infantry.',
    hp: 35,
    radius: 9,
    speed: 75,
    attackDmg: 5,
    attackRange: 110,
    attackSpeed: 0.8,
    bonusVs: { typeIds: ['spearman', 'spearman_enemy'], dmg: 4 },
    armor: 0,
    trainTime: 22,
    cost: { wood: 30, gold: 25 },
    popCost: 1,
    builtAt: ['archery_range'],
    primaryColor: '#588958',
    accentColor: '#e8d090',
    weaponColor: '#a08050',
    ranged: true,
  },
  cavalry: {
    typeId: 'cavalry',
    name: 'Ashvarudha',
    description: 'Mounted warrior. Fast, strong against archers.',
    hp: 90,
    radius: 12,
    speed: 130,
    attackDmg: 8,
    attackRange: 22,
    attackSpeed: 0.9,
    bonusVs: { typeIds: ['archer', 'archer_enemy'], dmg: 6 },
    armor: 1,
    trainTime: 26,
    cost: { food: 60, gold: 40 },
    popCost: 2,
    builtAt: ['stable'],
    primaryColor: '#4a6fb0',
    accentColor: '#e0c060',
    weaponColor: '#cdd1d4',
    ranged: false,
  },

  // Enemy variants (Lanka — rakshasas). Same archetypes, darker palette,
  // tagged so spearman bonus damage still hits "enemy cavalry".
  villager_enemy: {
    typeId: 'villager_enemy',
    name: 'Rakshasa Worker',
    description: 'Lanka civilian. Gathers and builds for the enemy.',
    hp: 40, radius: 9, speed: 70,
    attackDmg: 3, attackRange: 16, attackSpeed: 1.0, armor: 0,
    gatherRate: 0.6, gatherCapacity: 10, canBuild: true, sightRange: 5,
    trainTime: 18, cost: { food: 50 }, popCost: 1, builtAt: ['town_center_enemy'],
    primaryColor: '#7a3838', accentColor: '#3a1a1a', weaponColor: '#5a3a2a',
    ranged: false,
  },
  spearman_enemy: {
    typeId: 'spearman_enemy', name: 'Asura Spear',
    description: 'Rakshasa spear infantry.',
    hp: 60, radius: 10, speed: 80,
    attackDmg: 6, attackRange: 22, attackSpeed: 1.0,
    bonusVs: { typeIds: ['cavalry', 'cavalry_enemy'], dmg: 10 },
    armor: 1,
    trainTime: 18, cost: { food: 35, wood: 25 }, popCost: 1, builtAt: ['barracks_enemy'],
    primaryColor: '#a04040', accentColor: '#1a1a1a', weaponColor: '#cdd1d4', ranged: false,
  },
  archer_enemy: {
    typeId: 'archer_enemy', name: 'Asura Archer',
    description: 'Rakshasa archer.',
    hp: 35, radius: 9, speed: 75,
    attackDmg: 5, attackRange: 110, attackSpeed: 0.8,
    bonusVs: { typeIds: ['spearman', 'spearman_enemy'], dmg: 4 },
    armor: 0,
    trainTime: 22, cost: { wood: 30, gold: 25 }, popCost: 1, builtAt: ['archery_range_enemy'],
    primaryColor: '#7a3050', accentColor: '#1a1a1a', weaponColor: '#a08050', ranged: true,
  },
  cavalry_enemy: {
    typeId: 'cavalry_enemy', name: 'Asura Rider',
    description: 'Rakshasa cavalry.',
    hp: 90, radius: 12, speed: 130,
    attackDmg: 8, attackRange: 22, attackSpeed: 0.9,
    bonusVs: { typeIds: ['archer', 'archer_enemy'], dmg: 6 },
    armor: 1,
    trainTime: 26, cost: { food: 60, gold: 40 }, popCost: 2, builtAt: ['stable_enemy'],
    primaryColor: '#8b3a3a', accentColor: '#1a1a1a', weaponColor: '#cdd1d4', ranged: false,
  },

  // Rishi — neutral sage entity. Doesn't fight. Owner=1 so they're counted as
  // the player's protected VIPs. Slow movement (mostly meditates in place).
  // Killing one is a loss condition.
  rishi: {
    typeId: 'rishi',
    name: 'Rishi',
    description: 'A forest sage assisting the ritual. Keep the rakshasas from his throat.',
    hp: 160,
    radius: 11,
    speed: 30,
    armor: 2,
    hpRegen: 2,
    noBoxSelect: true,
    trainTime: 0,
    cost: {},
    popCost: 0,
    builtAt: [],
    primaryColor: '#d8a040',
    accentColor: '#f0c850',
    weaponColor: '#5a3a22',
    ranged: false,
  },
  vishwamitra: {
    typeId: 'vishwamitra',
    name: 'Vishwamitra',
    description: 'The great sage. His Yajna anchors dharma in Dandaka. His tapas shields him — but not forever.',
    hp: 320,
    radius: 12,
    speed: 30,
    armor: 3,
    hpRegen: 2,
    noBoxSelect: true,
    trainTime: 0,
    cost: {},
    popCost: 0,
    builtAt: [],
    primaryColor: '#e8b040',
    accentColor: '#f0c850',
    weaponColor: '#5a3a22',
    ranged: false,
  },

  // Ambient wildlife — owner=0 (gaia), no attack, wanders, drops food when killed.
  deer: {
    typeId: 'deer',
    name: 'Deer',
    description: 'A forest deer. Hunt it for food.',
    hp: 35,
    radius: 11,
    speed: 90,
    armor: 0,
    trainTime: 0,
    cost: {},
    popCost: 0,
    builtAt: [],
    primaryColor: '#b88a5a',
    accentColor: '#f0e0c0',
    weaponColor: '#000000',
    ranged: false,
  },

  // Basic rakshasa minion that pours in waves.
  grunt_enemy: {
    typeId: 'grunt_enemy',
    name: 'Rakshasa Grunt',
    description: 'A horned demon footsoldier. Fast, weak, comes in numbers.',
    hp: 50,
    radius: 10,
    speed: 95,
    attackDmg: 8,
    attackRange: 18,
    attackSpeed: 1.2,
    armor: 0,
    trainTime: 0,
    cost: {},
    popCost: 0,
    builtAt: [],
    primaryColor: '#8b3030',
    accentColor: '#1a0a0a',
    weaponColor: '#1a1a1a',
    ranged: false,
  },

  // ---- Bosses & special enemies ----
  tataka: {
    typeId: 'tataka',
    name: 'Tataka',
    description: 'The rakshasi queen. Final boss of the Bala Kanda.',
    hp: 800,
    radius: 18,
    speed: 60,
    bossTier: 'major',
    sizeScale: 1.25,
    attackDmg: 24,
    attackRange: 26,
    attackSpeed: 0.8,
    armor: 4,
    trainTime: 0,
    cost: {},
    popCost: 0,
    builtAt: [],
    primaryColor: '#3a4060',
    accentColor: '#aa1a1a',
    weaponColor: '#1a0a0a',
    ranged: false,
  },
  subahu: {
    typeId: 'subahu',
    name: 'Subahu',
    description: 'Tataka’s brute son. Heavy melee mid-boss.',
    hp: 400,
    radius: 14,
    speed: 75,
    bossTier: 'mid',
    sizeScale: 1.25,
    attackDmg: 22,
    attackRange: 22,
    attackSpeed: 0.9,
    armor: 3,
    trainTime: 0,
    cost: {},
    popCost: 0,
    builtAt: [],
    primaryColor: '#5a2820',
    accentColor: '#0a0a0a',
    weaponColor: '#1a1a1a',
    ranged: false,
  },
  maricha: {
    typeId: 'maricha',
    name: 'Maricha',
    description: 'Tataka’s sly son. Fast and ranged.',
    hp: 250,
    radius: 11,
    speed: 130,
    bossTier: 'mid',
    attackDmg: 16,
    attackRange: 110,
    attackSpeed: 1.2,
    armor: 1,
    trainTime: 0,
    cost: {},
    popCost: 0,
    builtAt: [],
    primaryColor: '#5a3a50',
    accentColor: '#1a0a1a',
    weaponColor: '#a08050',
    ranged: true,
  },
};
