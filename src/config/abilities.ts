// Hero special abilities. Each has a unique cast/effect — they're not just
// damage variants. Cooldowns are sim-time gated; the HUD reads them to render
// progress wheels and grey out the button while not ready.

export interface AbilityDef {
  id: string;
  name: string;
  themedName?: string;
  description: string;
  /** Owning unit typeId. */
  ownerTypeId: string;
  /** Cooldown in seconds. */
  cooldown: number;
  /** Food cost to cast. */
  foodCost: number;
  /** Range in pixels (for targeted abilities). */
  range: number;
  /** Damage dealt to each entity the ability hits. */
  damage: number;
  /** Hotkey label (single letter or letter combo). */
  hotkey?: string;
  /** Icon sprite key (rendered in the action button). */
  iconKey?: string;
}

export const ABILITY_DEFS: Record<string, AbilityDef> = {
  brahmastra: {
    id: 'brahmastra',
    name: 'Brahmastra',
    themedName: 'Divine Arrow',
    description: 'A piercing arrow of divine fire. Travels in a line, dealing 120 damage to every enemy it touches. 60s cooldown.',
    ownerTypeId: 'rama',
    cooldown: 60,
    foodCost: 30,
    range: 600,
    damage: 120,
    hotkey: 'Q',
    iconKey: 'icon-brahmastra',
  },
  indrastra: {
    id: 'indrastra',
    name: 'Indrastra',
    themedName: 'Storm Arrow',
    description: 'A crackling bolt that strikes a single target for 90 damage and briefly stuns them. 45s cooldown.',
    ownerTypeId: 'lakshmana',
    cooldown: 45,
    foodCost: 20,
    range: 360,
    damage: 90,
    hotkey: 'E',
    iconKey: 'icon-indrastra',
  },
};
