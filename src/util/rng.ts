// Deterministic PRNG for the simulation. Everything that affects sim state
// must draw from here (never Math.random) so that a (seed, command-stream)
// pair replays identically — the foundation for save/load and headless tests.
// Render-side effects (camera shake jitter etc.) may keep Math.random.

/** Callable PRNG plus state accessors so snapshot saves can capture and
 *  restore the exact stream position (see src/save.ts). */
export interface Rng {
  /** Uniform float in [0, 1). */
  (): number;
  /** Current internal 32-bit state (unsigned). */
  getState(): number;
  /** Restore a state previously captured with getState(). */
  setState(s: number): void;
}

/** mulberry32 — small, fast, good-enough distribution for gameplay. */
export function makeRng(seed: number): Rng {
  let s = seed >>> 0;
  const rng = (() => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as Rng;
  rng.getState = () => s >>> 0;
  rng.setState = (v: number) => { s = v >>> 0; };
  return rng;
}

/** Uniform integer in [0, n). */
export function rngInt(rng: Rng, n: number): number {
  return Math.floor(rng() * n);
}
