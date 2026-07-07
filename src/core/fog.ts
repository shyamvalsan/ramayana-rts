// Per-player tile visibility ("fog of war").
//
//   - State 0: unexplored. Pitch black.
//   - State 1: explored (seen before, not currently visible). Dim grey. Buildings
//     and terrain stay drawn as last seen; units do not.
//   - State 2: visible. Full color.
//
// We compute visibility every ~250ms (4 Hz) — enough to feel responsive but
// cheap relative to a full per-tick recompute. Sight ranges come from data:
// UNIT_DEFS[*].sightRange / BUILDING_DEFS[*].sightRange, falling back to
// 7 tiles for units and 6 for buildings when a def omits the field.

import { MAP_TILES_X, MAP_TILES_Y, TILE_SIZE } from '@/config/constants';
import { BUILDING_DEFS } from '@/config/buildings';
import { UNIT_DEFS } from '@/config/units';
import type { Entity, PlayerId } from '@/core/types';

export const VIS_UNSEEN = 0;
export const VIS_EXPLORED = 1;
export const VIS_VISIBLE = 2;

// Default sight ranges (in tiles) for defs without an explicit sightRange.
const DEFAULT_UNIT_SIGHT = 7;
const DEFAULT_BUILDING_SIGHT = 6;

export class FogMap {
  readonly w: number;
  readonly h: number;
  // 0=unseen, 1=explored, 2=visible. Packed as Uint8Array for cache friendliness.
  vis: Uint8Array;

  constructor(w = MAP_TILES_X, h = MAP_TILES_Y) {
    this.w = w;
    this.h = h;
    this.vis = new Uint8Array(w * h);
  }

  get(tx: number, ty: number): number {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return VIS_UNSEEN;
    return this.vis[ty * this.w + tx];
  }

  // Set every currently-visible tile back to explored (1), preserve unseen (0).
  beginFrame() {
    for (let i = 0; i < this.vis.length; i++) {
      const v = this.vis[i];
      // Visible → explored. Unexplored stays unexplored.
      this.vis[i] = v === VIS_VISIBLE ? VIS_EXPLORED : v;
    }
  }

  // Stamp a circular visible region around (cx, cy) with radius (in tiles).
  reveal(cx: number, cy: number, r: number) {
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(this.w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(this.h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      const dy2 = dy * dy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy2 <= r2) this.vis[y * this.w + x] = VIS_VISIBLE;
      }
    }
  }

  // Recompute visibility from a list of "vision sources" (entities owned by the
  // player). Buildings and units all contribute.
  recompute(entities: Iterable<Entity>, owner: PlayerId) {
    this.beginFrame();
    for (const e of entities) {
      if (e.dead) continue;
      if (e.owner !== owner) continue;
      const sight = sightOf(e);
      if (sight <= 0) continue;
      // Tile center of the entity.
      const tx = (e.pos.x / TILE_SIZE);
      const ty = (e.pos.y / TILE_SIZE);
      this.reveal(tx, ty, sight);
    }
  }
}

export function sightOf(e: Entity): number {
  if (e.kind === 'unit') {
    return UNIT_DEFS[e.typeId]?.sightRange ?? DEFAULT_UNIT_SIGHT;
  }
  if (e.kind === 'building') {
    return BUILDING_DEFS[e.typeId]?.sightRange ?? DEFAULT_BUILDING_SIGHT;
  }
  return 0;
}
