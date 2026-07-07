// Resource node definitions (trees, berries, gold, stone). For session 1 the
// vertical slice only ships trees; the rest are scaffolded so the renderer and
// FSM already know how to deal with them.

import type { ResourceKind } from '@/core/types';

export interface ResourceNodeDef {
  typeId: string;
  name: string;
  resource: ResourceKind;
  sizeTiles: { w: number; h: number };
  amount: number;
  primaryColor: string;
  accentColor: string;
}

export const RESOURCE_DEFS: Record<string, ResourceNodeDef> = {
  tree: {
    typeId: 'tree',
    name: 'Tree',
    resource: 'wood',
    sizeTiles: { w: 1, h: 1 },
    amount: 120,
    primaryColor: '#2e5a2e',
    accentColor: '#1c3a1c',
  },
  berry_bush: {
    typeId: 'berry_bush',
    name: 'Berry Bush',
    resource: 'food',
    sizeTiles: { w: 1, h: 1 },
    amount: 100,
    primaryColor: '#8a3a3a',
    accentColor: '#5a1f1f',
  },
  gold_vein: {
    typeId: 'gold_vein',
    name: 'Gold Vein',
    resource: 'gold',
    sizeTiles: { w: 1, h: 1 },
    amount: 800,
    primaryColor: '#d4af4a',
    accentColor: '#8a6a20',
  },
  stone_vein: {
    typeId: 'stone_vein',
    name: 'Stone Vein',
    resource: 'stone',
    sizeTiles: { w: 1, h: 1 },
    amount: 600,
    primaryColor: '#9aa4ae',
    accentColor: '#5a6470',
  },
};
