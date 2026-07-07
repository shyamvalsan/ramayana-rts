// A* with 8-direction movement on a tile grid. Corners are not cut through
// pairs of blocked tiles (prevents squeezing between buildings).

import type { TilePos } from '@/core/types';
import { World } from '@/core/world';

interface Node {
  tx: number;
  ty: number;
  g: number;        // cost from start
  f: number;        // g + h
  parent: Node | null;
}

const DIRS: [number, number, number][] = [
  // dx, dy, cost
  [ 1,  0, 1.0],
  [-1,  0, 1.0],
  [ 0,  1, 1.0],
  [ 0, -1, 1.0],
  [ 1,  1, Math.SQRT2],
  [-1,  1, Math.SQRT2],
  [ 1, -1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

const octile = (ax: number, ay: number, bx: number, by: number) => {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
};

// Min-heap keyed on f. Bare-bones; pop/push are O(log n).
class MinHeap {
  private a: Node[] = [];
  size() { return this.a.length; }
  push(n: Node) {
    this.a.push(n);
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.a[p].f <= this.a[i].f) break;
      [this.a[p], this.a[i]] = [this.a[i], this.a[p]];
      i = p;
    }
  }
  pop(): Node | undefined {
    if (this.a.length === 0) return undefined;
    const top = this.a[0];
    const last = this.a.pop()!;
    if (this.a.length > 0) {
      this.a[0] = last;
      let i = 0;
      const n = this.a.length;
      while (true) {
        const l = i * 2 + 1, r = i * 2 + 2;
        let smallest = i;
        if (l < n && this.a[l].f < this.a[smallest].f) smallest = l;
        if (r < n && this.a[r].f < this.a[smallest].f) smallest = r;
        if (smallest === i) break;
        [this.a[i], this.a[smallest]] = [this.a[smallest], this.a[i]];
        i = smallest;
      }
    }
    return top;
  }
}

export interface PathfindOptions {
  // If non-zero, tiles whose blocker matches ignoreBlockerId are treated as
  // passable. Used when pathing to/from your own building tile.
  ignoreBlockerId?: number;
  // If set, also treat these tiles as passable (target tile of a resource node etc).
  passableTiles?: TilePos[];
  // Cap iterations to avoid runaway on huge maps.
  maxIterations?: number;
}

export function findPath(
  world: World,
  start: TilePos,
  goal: TilePos,
  opts: PathfindOptions = {},
): TilePos[] | null {
  if (!world.inBounds(start.tx, start.ty)) return null;
  if (start.tx === goal.tx && start.ty === goal.ty) return [];

  const passable = (tx: number, ty: number) => {
    if (!world.inBounds(tx, ty)) return false;
    if (world.terrain[world.idx(tx, ty)] === 2) return false;
    const b = world.blocker[world.idx(tx, ty)];
    if (b === 0) return true;
    if (opts.ignoreBlockerId && b === opts.ignoreBlockerId) return true;
    if (opts.passableTiles) {
      for (const t of opts.passableTiles) if (t.tx === tx && t.ty === ty) return true;
    }
    return false;
  };

  // If goal itself isn't passable, allow it as a final target (you walk up to
  // it). The reverse-walk reconstruction will stop one tile away if needed.
  const goalPassable = passable(goal.tx, goal.ty);

  const open = new MinHeap();
  const closed = new Set<number>();
  const bestG = new Map<number, number>();
  const startNode: Node = {
    tx: start.tx, ty: start.ty,
    g: 0, f: octile(start.tx, start.ty, goal.tx, goal.ty),
    parent: null,
  };
  open.push(startNode);
  bestG.set(start.ty * world.w + start.tx, 0);

  // Map is 80×60 = 4800 tiles. Long cross-map paths can expand many nodes.
  const maxIter = opts.maxIterations ?? 60000;
  let iter = 0;

  while (open.size() > 0) {
    if (++iter > maxIter) return null;
    const cur = open.pop()!;
    if (cur.tx === goal.tx && cur.ty === goal.ty) {
      const path = reconstruct(cur);
      // Impassable goal (building footprint, water): stop on the last
      // passable tile instead of walking onto the blocker.
      if (!goalPassable && path.length > 0) path.pop();
      return path;
    }
    const ck = cur.ty * world.w + cur.tx;
    if (closed.has(ck)) continue;
    closed.add(ck);

    for (const [dx, dy, cost] of DIRS) {
      const nx = cur.tx + dx;
      const ny = cur.ty + dy;
      if (!world.inBounds(nx, ny)) continue;
      const isGoal = nx === goal.tx && ny === goal.ty;
      // An impassable goal may still be targeted — reconstruct() trims it so
      // the walk stops on the last passable tile before it.
      if (!isGoal && !passable(nx, ny)) continue;
      // Prevent diagonal corner-cut through two blocked orthogonal neighbors.
      if (dx !== 0 && dy !== 0) {
        if (!passable(cur.tx + dx, cur.ty) && !passable(cur.tx, cur.ty + dy)) continue;
      }

      const g = cur.g + cost;
      const nk = ny * world.w + nx;
      const prevG = bestG.get(nk);
      if (prevG !== undefined && g >= prevG) continue;
      bestG.set(nk, g);
      open.push({
        tx: nx, ty: ny,
        g,
        f: g + octile(nx, ny, goal.tx, goal.ty),
        parent: cur,
      });
    }
  }
  return null;
}

function reconstruct(end: Node): TilePos[] {
  const out: TilePos[] = [];
  let n: Node | null = end;
  while (n) {
    out.push({ tx: n.tx, ty: n.ty });
    n = n.parent;
  }
  out.reverse();
  // Drop start tile — caller already stands on it.
  return out.slice(1);
}

// Convenience: pick the closest tile adjacent to a target footprint that's
// reachable from start. Used for "walk up to this building/tree" queries.
export function findPathToAdjacent(
  world: World,
  start: TilePos,
  footprint: TilePos[],
  opts: PathfindOptions = {},
): TilePos[] | null {
  // Generate candidate adjacent tiles around the footprint.
  const candidates: TilePos[] = [];
  const seen = new Set<number>();
  const fpSet = new Set(footprint.map(t => t.ty * world.w + t.tx));
  for (const t of footprint) {
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]) {
      const nx = t.tx + dx;
      const ny = t.ty + dy;
      const k = ny * world.w + nx;
      if (fpSet.has(k)) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      if (!world.inBounds(nx, ny)) continue;
      // Candidate must be passable (or passable via the caller's options).
      if (world.terrain[world.idx(nx, ny)] === 2) continue;
      const b = world.blocker[world.idx(nx, ny)];
      if (b !== 0 && b !== opts.ignoreBlockerId
        && !opts.passableTiles?.some(t => t.tx === nx && t.ty === ny)) continue;
      candidates.push({ tx: nx, ty: ny });
    }
  }
  // Try shortest by octile distance first.
  candidates.sort((a, b) =>
    octile(a.tx, a.ty, start.tx, start.ty) - octile(b.tx, b.ty, start.tx, start.ty));
  for (const c of candidates) {
    const path = findPath(world, start, c, opts);
    if (path !== null) return path;
  }
  return null;
}
