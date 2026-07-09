// Generalized wave director — the scheduled-assault enemy brain shared by
// campaign missions. Ticks from Game via the duck-typed game.ais contract
// (only tick(deps) is required).
//
// One front per wave: the whole band spawns clustered on a single map edge so
// the player can intercept it, with the direction called out in the warning.
// Spawn placement spiral-searches for passable tiles — a wave unit whose
// death the win condition requires must NEVER be silently dropped.

import { tileCenter } from '@/util/math';

export interface WaveUnit {
  typeId: string;
  count: number;
}

export interface WaveDef {
  /** Seconds since mission start (scaled by waveScale). */
  at: number;
  units: WaveUnit[];
  /** Player-facing toast; the spawn edge is appended automatically. */
  warning?: string;
  /** Restrict this wave to specific edges (0=N 1=S 2=W 3=E). */
  edges?: number[];
  /** Extra camera shake on spawn (boss entrances). */
  shake?: number;
}

export interface WaveDirectorOpts {
  ownerId: number;
  /** Where waves attack-move to (the mission objective). */
  homePos: { x: number; y: number };
  waves: WaveDef[];
  /** Global timing multiplier — the single balance knob (>1 = slower). */
  waveScale?: number;
  /** Per-typeId shake defaults for dramatic entrances. */
  bossShake?: Record<string, number>;
}

export class WaveDirector {
  ownerId: number;
  homePos: { x: number; y: number };
  waves: WaveDef[];
  waveScale: number;
  bossShake: Record<string, number>;
  startTime = 0;
  nextWaveIdx = 0;
  /** Sim time of the next wave; -1 once all waves have spawned. Read by HUD. */
  nextWaveScheduledAt = 0;

  constructor(opts: WaveDirectorOpts) {
    this.ownerId = opts.ownerId;
    this.homePos = opts.homePos;
    this.waves = opts.waves;
    this.waveScale = opts.waveScale ?? 1;
    this.bossShake = opts.bossShake ?? {};
    this.nextWaveScheduledAt = this.waves.length ? this.waves[0].at * this.waveScale : -1;
  }

  get totalWaves() { return this.waves.length; }

  /** All waves spawned and none of this owner's units left alive. */
  cleared(deps: any): boolean {
    if (this.nextWaveIdx < this.waves.length) return false;
    for (const e of deps.entities.values()) {
      if (e.owner === this.ownerId && e.kind === 'unit' && !e.dead) return false;
    }
    return true;
  }

  tick(deps: any) {
    // Wave hold (tutorial sandbox): freeze the schedule at ~0 elapsed so no
    // enemies spawn and the HUD shows a steady countdown to the first wave.
    if (deps.waveHold) {
      this.startTime = deps.now;
      this.nextWaveScheduledAt = this.waves.length ? deps.now + this.waves[0].at * this.waveScale : -1;
      return;
    }
    const elapsed = deps.now - this.startTime;
    while (this.nextWaveIdx < this.waves.length
      && elapsed >= this.waves[this.nextWaveIdx].at * this.waveScale) {
      this.spawnWave(deps, this.waves[this.nextWaveIdx]);
      this.nextWaveIdx++;
    }
    this.nextWaveScheduledAt = this.nextWaveIdx < this.waves.length
      ? this.startTime + this.waves[this.nextWaveIdx].at * this.waveScale
      : -1;
    // Re-aim idle enemies at the objective — throttled per unit; per-tick
    // order spam resets walk states and burns A* time.
    for (const e of deps.entities.values()) {
      if (e.owner !== this.ownerId || e.kind !== 'unit' || e.dead) continue;
      if (e.state?.kind !== 'idle') continue;
      if (deps.now < (e.nextOrderAt ?? 0)) continue;
      e.nextOrderAt = deps.now + 2.0;
      deps.issueAttackMove(e, this.homePos);
    }
  }

  /** Passable spawn tile near (tx, ty): spiral out, then walk the border. */
  private findSpawnTile(world: any, tx: number, ty: number): { tx: number; ty: number } | null {
    if (world.isPassable(tx, ty)) return { tx, ty };
    for (let r = 1; r <= 8; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (world.isPassable(tx + dx, ty + dy)) return { tx: tx + dx, ty: ty + dy };
        }
      }
    }
    for (let x = 1; x < world.w - 1; x++) {
      if (world.isPassable(x, 1)) return { tx: x, ty: 1 };
      if (world.isPassable(x, world.h - 2)) return { tx: x, ty: world.h - 2 };
    }
    return null;
  }

  private spawnWave(deps: any, wave: WaveDef) {
    const rng = deps.rng ?? Math.random;
    const w = deps.world.w, h = deps.world.h;
    const edgeChoices = wave.edges ?? [0, 1, 2, 3];
    const edge = edgeChoices[Math.floor(rng() * edgeChoices.length)];
    const EDGE_NAMES = ['NORTH', 'SOUTH', 'WEST', 'EAST'];
    if (wave.warning) {
      const text = `${wave.warning} (from the ${EDGE_NAMES[edge]})`;
      deps.notify?.(text);
      deps.alertWave?.(text, 2.6);
    }
    if (wave.shake) deps.addShake?.(wave.shake);
    // Cluster center along the edge, kept away from corners.
    const alongX = Math.floor(w * (0.3 + rng() * 0.4));
    const alongY = Math.floor(h * (0.3 + rng() * 0.4));
    for (const u of wave.units) {
      for (let i = 0; i < u.count; i++) {
        const spread = Math.floor(rng() * 13) - 6; // ±6 tiles along the edge
        let tx = 0, ty = 0;
        if (edge === 0) { tx = alongX + spread; ty = 1; }
        else if (edge === 1) { tx = alongX + spread; ty = h - 2; }
        else if (edge === 2) { tx = 1; ty = alongY + spread; }
        else { tx = w - 2; ty = alongY + spread; }
        tx = Math.max(1, Math.min(w - 2, tx));
        ty = Math.max(1, Math.min(h - 2, ty));
        const spot = this.findSpawnTile(deps.world, tx, ty);
        if (!spot) continue; // no passable border tile exists — not a real map
        const ent = deps.spawnUnit?.(u.typeId, this.ownerId, tileCenter(spot.tx, spot.ty));
        if (ent) {
          deps.issueAttackMove(ent, this.homePos);
          const shake = this.bossShake[u.typeId];
          if (shake) deps.addShake?.(shake);
        }
      }
    }
  }
}
