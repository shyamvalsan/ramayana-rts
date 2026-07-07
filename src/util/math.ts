import { TILE_SIZE } from '@/config/constants';
import type { TilePos, Vec2 } from '@/core/types';

export const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

export const dist2 = (a: Vec2, b: Vec2) => {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
};

export const tileCenter = (tx: number, ty: number): Vec2 => ({
  x: tx * TILE_SIZE + TILE_SIZE / 2,
  y: ty * TILE_SIZE + TILE_SIZE / 2,
});

export const worldToTile = (p: Vec2): TilePos => ({
  tx: Math.floor(p.x / TILE_SIZE),
  ty: Math.floor(p.y / TILE_SIZE),
});

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
