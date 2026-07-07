// Map and rendering constants. Coordinates: 1 tile = TILE_SIZE world pixels.
// World is tile-grid; units have continuous world positions inside that grid.

export const TILE_SIZE = 32;

export const MAP_TILES_X = 80;
export const MAP_TILES_Y = 60;

export const MAP_W = MAP_TILES_X * TILE_SIZE;
export const MAP_H = MAP_TILES_Y * TILE_SIZE;

// Camera pan rate in pixels per second.
export const CAMERA_PAN_SPEED = 800;
export const CAMERA_EDGE_PAN_MARGIN = 24;

// Visual layer.
export const COLORS = {
  // Terrain
  grass1: '#3d6b3a',
  grass2: '#446f3f',
  grassPath: '#7b6a3a',
  dirt: '#6b5a3a',
  water: '#2a4a6a',
  forestUnderlay: '#1e3a1e',

  // Generic UI
  uiAccent: '#f0c850',
  uiAccentDim: '#c9a23a',
  uiPanel: 'rgba(15, 22, 30, 0.88)',
  selectRing: '#7eff7a',
  hostileRing: '#ff5a5a',
  buildPlaceOk: 'rgba(126, 255, 122, 0.35)',
  buildPlaceBad: 'rgba(255, 90, 90, 0.35)',

  // Player faction (Ayodhya — blue & gold)
  playerPrimary: '#3a7fd6',
  playerSecondary: '#f0c850',

  // Enemy faction (Lanka — red & black) — unused this session
  enemyPrimary: '#c93a3a',
  enemyAccent: '#1a1a1a',

  // Resource swatches
  wood: '#8b5a2b',
  food: '#d04040',
  gold: '#f0c850',
  stone: '#aab4be',

  // Health
  hpBg: '#222',
  hpGood: '#5cc25c',
  hpBad: '#d04040',
} as const;

// Starting resources for a new game.
export const STARTING_RESOURCES = {
  wood: 200,
  food: 200,
  gold: 100,
  stone: 100,
} as const;

export const STARTING_POP_CAP = 5;
export const MAX_POP_CAP = 200;

// Tick: simulation runs at fixed 60Hz; rendering happens at requestAnimationFrame rate.
export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ; // seconds per tick

// Isometric Y-squish: world Y is rendered at 60% of world X scale, giving a
// foreshortened "looking down at a tilted plane" feeling that mimics the AoE
// dimetric projection without rewriting the renderer for true diamond tiles.
export const ISO_Y_SCALE = 0.62;
