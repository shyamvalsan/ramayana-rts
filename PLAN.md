# Ramayana RTS — Road to SOTA

Working plan for the overnight autonomous build (2026-07-04). Owner: Claude.
Baseline commit `111295e`. Each phase lands as its own commit after typecheck +
in-browser verification.

## Where the game stands

The engine (fixed-tick sim, A* pathfinding, fog, canvas renderer, DOM HUD,
procedural audio, agent API) is sound. The shipped content is the Bala Kanda
defense mission — and it is **softlocked**: enemy waves crowd around the Yajna
forever without attacking. A dormant skirmish mode (full economy, Lanka AI,
enemy base buildings, villager UI) survives in the codebase as unreachable
content. Full subsystem maps + defect lists live in the session scratchpad;
the high-severity defects are listed per phase below.

## Phase A — Make the game work (engine correctness)

1. **Movement/combat overhaul** (the softlock):
   - Range-aware arrival: while `moving`, check the queued intent every tick —
     if the queued attack/gather/build target is already in interaction range,
     transition immediately instead of insisting on reaching an exact tile center.
   - `attackMove` acquires targets mid-path (throttled scan), per its own docs.
   - Separation no longer cancels goal progress (cap it, project it, and clamp
     pushes with `world.isPassable`).
   - Pathfinding: fix the broken impassable-goal handling; re-path with backoff
     instead of every-AI-tick command spam.
2. **Win/lose correctness**: persistent `bossEverSpawned` flag; deterministic
   fallback spawn tiles so Tataka can never be silently dropped.
3. **Camera**: center on the mission anchor (Yajna), fix `H` hotkey; add wheel zoom
   (plumbing already half-exists).
4. **HUD**: real resource bar (food/wood/gold/stone/pop — currently every element
   aliases the food pill).
5. **Bug sweep** from the mapping pass: Indrastra range + real timed stun; ability
   damage from defs; tile-freeing on ability kills; waveAlert aging after game end;
   music-state reset on restart; mute-before-init; stopMusic on title return; fog
   sight ranges from defs; corpse render fade; placement-ghost / death-puff iso
   projection; health-bar fog leak; et al.
6. **Determinism**: seeded PRNG (mulberry32) through all sim-affecting randomness
   (separation jitter, wave spawns, wildlife) — prerequisite for save/load.

## Phase B — Campaign architecture + content

1. **Mission abstraction**: `MissionDef { id, name, load(game), evaluateOutcome,
   tick hooks, anchor, heroes, cutscene set, help content, hud config, end text }`;
   registry; `game.evaluateOutcome`/Tataka-phase logic moves into the Bala Kanda def.
2. **Mission select**: title-screen chapter grid (visual pattern already exists in
   the end-screen teasers), per-mission lock state in localStorage.
3. **Three campaign missions**:
   - **I. Bala Kanda** (exists — fix, tune, keep heroes-only defense + boss).
   - **II. Aranya Kanda** — economy + defense: build the Panchavati settlement,
     survive Khara's escalating raids (villagers + military + heroes).
   - **III. Yuddha Kanda** — the dormant skirmish revived: destroy the Lanka
     Citadel vs the AIController economy AI. (Design details from panel workflow.)
4. **Save/load**: snapshot serialization of Game + director/AI state + mission id;
   save/load in pause menu; quicksave/quickload; agent-API surface.

## Phase C — RTS depth

1. **Formations & group movement**: slot-offset group moves, arrival spread,
   group cohesion (march at slowest speed), control groups (Ctrl+1-9),
   attack-move/hold buttons that actually work (command primer).
2. **Walls & gates**: drag-line wall placement, gate open/close with passability
   toggle, enemy attack-nearest-blocker fallback so walls can't fully cheese waves.
3. **Tech tree ("Blessings")**: building-hosted researches (per-player stat
   modifier layer, NOT def mutation — defs are shared across factions):
   e.g. Bala & Atibala mantras (villager work rate), weapon/armor lines at
   barracks/range/stable, watchtower upgrades. Content from panel workflow.

## Phase D — Polish

- Zoom, minimap gaia dots, idle-villager pill, double-click select-same-type.
- Per-mission help overlay + tutorial; fixed fonts (self-host); favicon.
- Sprites for walls/gates via the existing gen-images pipeline (procedural fallback).
- README rewrite to match reality; content pipeline fixes (story.json copy step).

## Verification protocol (every phase)

`tsc -b` clean → vite build → browser playtest (autopilot + scripted agent-API
runs at 8-16×, screenshots inspected visually) → `review-and-fix` workflow on the
diff → balance runs (headless, 3+ strategies) for gameplay phases → commit.

## Multi-agent setup

- `.claude/agents/`: rts-feature-dev, rts-playtester, rts-balance-judge.
- `.claude/workflows/`: review-and-fix (4-dimension diff review with adversarial
  verification then fixes), playtest-matrix (sequential browser playtests).
