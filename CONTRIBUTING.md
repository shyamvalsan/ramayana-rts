# Contributing to Ramayana RTS

Thanks for wanting to build on this. The game is open source (MIT) and the
architecture is deliberately data-driven so new content is additive, not
surgical. This guide points you at the right seam for whatever you want to add.

## Getting started

```bash
npm install
npm run dev        # http://127.0.0.1:5173/
npm run typecheck  # tsc, no emit — keep this green
npm run build      # production bundle to dist/
```

There is no test runner; verification is done by driving the game. Two fast
ways to exercise a change:

- **In the browser:** `?skipintro=1&mission=<id>&autopilot=1&speed=16` plays a
  mission at 16× with the built-in bot. `window.rts.api` (see the README) lets
  you script scenarios from the console.
- **Headless:** `?headless=1` runs the sim with no rendering for quick logic
  checks.

## Where things live

- `src/config/` — the data layer. Units, buildings, resources, abilities,
  **techs**. Most balance and content changes are edits here, no code.
- `src/missions/` — one file per mission implementing `MissionDef`
  (`types.ts`). A mission owns its map, win/lose rules, scripted beats, heroes,
  and which HUD/tech features show. `index.ts` is the registry.
- `src/systems/` — per-tick simulation: the unit FSM, production, the economy
  `AIController`, the `WaveDirector`, towers, gates, wildlife, and the demo
  `autoplayer`.
- `src/core/` — `Game` (owns all state), the tile `World`, A* pathfinding, the
  camera, input, fog, and the seeded RNG.
- `src/render/` and `src/ui/` — canvas renderer and DOM HUD. Both are
  read-only over `Game`.

## Common contributions

**A new mission.** Copy `src/missions/balaKanda.ts` (defense) or
`aranyaKanda.ts` (economy), register it in `src/missions/index.ts`, and set its
`requires` to gate it in the campaign. Reuse the `WaveDirector` for scripted
waves or the `AIController` for a full economy opponent. Bosses reuse existing
art via `spriteBase` / `sizeScale` / `tintColor` on a unit def.

**New units, buildings, or techs.** Add a def in `src/config/`. Tech effects
apply per player through `game.getStat`-style stamping — never mutate a shared
def. New buildings enter play via `PLAYER_BUILDABLE`.

**Art.** Assets are AI-generated PNGs in `public/sprites/` with a cream chroma
-key background. Anything without art falls back to a procedural drawing, so
you can ship gameplay first and art later.

## Two rules the engine relies on

1. **Determinism.** All sim-affecting randomness must draw from `game.rng`
   (mulberry32), never `Math.random`. This is what makes save/load faithful.
   Render-only jitter may use `Math.random`.
2. **No softlocks.** A scripted mission beat may never gate a win without a
   timeout. If a story moment can stall, it must degrade to a notification and
   let the mission continue.

## Pull requests

Keep `npm run typecheck` green, describe what you changed and how you verified
it, and match the surrounding code style. Small, focused PRs get reviewed
fastest. New missions and balance passes are especially welcome.
