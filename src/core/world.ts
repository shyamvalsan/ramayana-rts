// The tile world: terrain + per-tile occupancy. Pathfinding queries this.

import { MAP_TILES_X, MAP_TILES_Y, TILE_SIZE } from '@/config/constants';
import type { EntityId, TilePos } from '@/core/types';

export type TerrainKind = 'grass' | 'dirt' | 'water';

export class World {
  readonly w = MAP_TILES_X;
  readonly h = MAP_TILES_Y;
  readonly tileSize = TILE_SIZE;

  // Per-tile terrain.
  terrain: Uint8Array; // 0=grass, 1=dirt, 2=water

  // Per-tile static blocker (buildings, resource nodes). Stores entity id (0 = empty).
  blocker: Int32Array;

  // Variation seed used for deterministic grass texture details.
  variation: Uint8Array;

  constructor() {
    const n = this.w * this.h;
    this.terrain = new Uint8Array(n); // default 0 = grass
    this.blocker = new Int32Array(n);
    this.variation = new Uint8Array(n);
    // Tiny PRNG for variation so the map doesn't look uniform.
    let s = 0x9E3779B1;
    for (let i = 0; i < n; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      this.variation[i] = s & 0xff;
    }
  }

  idx(tx: number, ty: number) { return ty * this.w + tx; }

  inBounds(tx: number, ty: number) {
    return tx >= 0 && ty >= 0 && tx < this.w && ty < this.h;
  }

  getTerrain(tx: number, ty: number): TerrainKind {
    if (!this.inBounds(tx, ty)) return 'water';
    const t = this.terrain[this.idx(tx, ty)];
    return t === 2 ? 'water' : t === 1 ? 'dirt' : 'grass';
  }

  setTerrain(tx: number, ty: number, kind: TerrainKind) {
    if (!this.inBounds(tx, ty)) return;
    this.terrain[this.idx(tx, ty)] = kind === 'water' ? 2 : kind === 'dirt' ? 1 : 0;
  }

  isPassable(tx: number, ty: number): boolean {
    if (!this.inBounds(tx, ty)) return false;
    if (this.terrain[this.idx(tx, ty)] === 2) return false; // water
    if (this.blocker[this.idx(tx, ty)] !== 0) return false;
    return true;
  }

  blockerAt(tx: number, ty: number): EntityId {
    if (!this.inBounds(tx, ty)) return 0;
    return this.blocker[this.idx(tx, ty)];
  }

  occupyTiles(tiles: TilePos[], id: EntityId) {
    for (const t of tiles) {
      if (this.inBounds(t.tx, t.ty)) this.blocker[this.idx(t.tx, t.ty)] = id;
    }
  }

  freeTiles(tiles: TilePos[]) {
    for (const t of tiles) {
      if (this.inBounds(t.tx, t.ty)) this.blocker[this.idx(t.tx, t.ty)] = 0;
    }
  }

  // For building placement: are all tiles in a rect free?
  canPlace(tx: number, ty: number, w: number, h: number): boolean {
    for (let y = ty; y < ty + h; y++) {
      for (let x = tx; x < tx + w; x++) {
        if (!this.isPassable(x, y)) return false;
      }
    }
    return true;
  }
}
