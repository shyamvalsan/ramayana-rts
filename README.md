# Ramayana RTS

A real-time strategy game that retells the Ramayana as a three-mission
campaign. Command Rama and Lakshmana — defend a sage's fire, raise a forest
settlement under siege, and storm the citadel of Lanka.

Inspired by Age of Empires II. Written in TypeScript with Vite, runs entirely
in the browser, no installs beyond `npm i`. All art is AI-generated; audio is
synthesized live in the Web Audio API.

**▶ Play it:** https://shyamvalsan.github.io/ramayana-rts/

> The engine, campaign, mission scripting, AI, and tech tree were designed and
> built by **Claude Fable 5** (Anthropic), with later polish and the
> open-source release carried on by **Claude Opus 4.8**. It's open source and
> looking for collaborators — see [Contributing](#contributing) and
> [Support the journey](#support--continue-the-journey).

## Run

```bash
npm install
npm run dev
# open http://127.0.0.1:5173/
```

`npm run build` type-checks and bundles to `dist/`. `npm run typecheck` runs
the compiler alone.

## The campaign

Three chapters, unlocked in order (progress is saved in `localStorage`). Pick a
chapter from the title screen; finishing one offers the next.

1. **Bala Kanda — "The Sacred Fire."** Heroes-only defense. Guard Vishwamitra's
   Yajna through five rakshasa waves; Tataka herself leads the last and enrages
   below half health. No economy — just Rama, Lakshmana, and their astras.
2. **Aranya Kanda — "The Hermitage at Panchavati."** Economy + defense. Raise
   the exile settlement by the Godavari, then survive Khara's escalating
   assault — Shurpanakha's provocation, Dushana and Trisiras, the golden deer,
   and Khara's three-front host. Ends on the hinge of the epic: Sita is gone.
3. **Yuddha Kanda — "The Siege of Lanka."** Full economy vs a prebuilt fortress
   across the sea, crossed only by Nala's causeway. Fight up the canon boss
   ladder — Prahasta, Kumbhakarna, Indrajit's Nagapasha, and Ravana himself —
   while an economy AI raids your beachhead. Win by razing the citadel *and*
   slaying Ravana.

## Controls

| Action | Input |
| --- | --- |
| Select unit / building | Left-click |
| Box-select | Left-click drag |
| Select all of a type on screen | Double-click a unit |
| Move / gather / attack / build | Right-click on ground, resource, enemy, or site |
| Queue a command | Shift + right-click |
| Attack-move | `A` then left-click a location (or the Attack Move button) |
| Assign / recall control group | `Ctrl+1..9` to assign, `1..9` to recall (double-tap to jump the camera) |
| Build menu | `B` with a villager selected (economy missions) |
| Cast hero ability | `Q` = Rama's Brahmastra, `E` = Lakshmana's Indrastra, then click a target |
| Cancel placement / cast | Right-click or `Escape` |
| Set rally point | Right-click ground with a production building selected |
| Pan camera | Arrow keys, `WASD`, edge-scroll, or middle-mouse drag |
| Center on base | `H` |
| Toggle mini-map | `M` |
| Pause menu | `Escape` (or `P` / Space to pause) |
| Save / load | `F5` quicksave, `F9` quickload (also in the pause menu) |
| Help overlay | `F1` or `?` |

## Units

| Ayodhya (you) | Lanka (enemy) | Role |
| --- | --- | --- |
| Villager | Rakshasa Worker | Gathers + builds |
| Bhata (Spearman) | Asura Spear | +bonus vs cavalry |
| Dhanvi (Archer) | Asura Archer | Ranged, +bonus vs spear |
| Ashvarudha (Cavalry) | Asura Rider | Fast, +bonus vs archer |
| Rama, Lakshmana | — | Hero archers with astras; regenerate out of combat |

Rock-paper-scissors: **Spear beats Cavalry, Cavalry beats Archer, Archer beats
Spear.** Bosses (Tataka, Khara, Kumbhakarna, Ravana, …) reuse the rakshasa art
at larger scale with tinted overlays and their own HP bar.

## Buildings

- **Ashram / Hermitage** (Town Center) — trains villagers, accepts all resources.
- **Kutira** (House) — +5 population cap.
- **Vana Shibira / Anna Shala / Khani Shibira** — wood / food / gold+stone drop-offs.
- **Senapati Bhavana / Dhanus Shala / Ashva Shala** — barracks / archery range / stable.
- **Tarana Stambha** (Watchtower) — auto-fires at enemies in range.
- **Prakara** (Wall) — drag to lay a line; blocks pathing.
- **Dwara** (Gate) — opens for your units, shuts against enemies.

## Blessings (tech tree)

Researched at their host building through the production queue. Effects apply
per player — never by mutating shared unit data, so friend and foe don't share
upgrades. Examples: **Bala / Atibala Mantra** (villager work rate + build
speed), **Agastya's Armory** and **Agneyastra Tips** (weapon upgrades),
**Vigil of Jatayu** (towers), **Indra's Kavacha** (armor), **Sanjivani Herb**
(instant hero heal), and the auto-granted **Aditya Hridayam** before the Ravana
duel. Aranya exposes six; Yuddha exposes all ten.

## Architecture

```
src/
  config/       — typed data: units, buildings, resources, abilities, techs, constants
  core/         — Game state, World grid, A* pathfinding, Camera, Input, fog, RNG
  entities/     — factory functions that build Entity records from config
  systems/      — per-tick logic (unit FSM, production, economy AI, towers, gates,
                  auto-engage, wildlife, autoplayer)
  missions/     — MissionDef framework + registry; balaKanda / aranyaKanda /
                  yuddhaKanda; the generalized WaveDirector
  render/       — canvas renderer, sprite loader + chroma-keyer
  ui/           — DOM HUD (resource bar, selection panel, build/research menu,
                  mini-map, tutorial, overlays)
  save.ts       — snapshot serialize / deserialize
  agentApi.ts   — public JS API on window.rts.api for scripted / headless play
  main.ts       — entry point, mission select, sim/render loop
public/sprites/ — AI-generated PNGs
```

### Missions are data + hooks

A `MissionDef` (see `src/missions/types.ts`) owns everything the engine used to
hardcode: map setup (`load`), win/lose rules (`evaluateOutcome`), scripted story
beats (`tick`), heroes, the camera anchor, end-screen copy, and which HUD
widgets and techs to show. `Game` delegates to the active mission; adding a
mission is a new file plus one line in `src/missions/index.ts`. Enemy brains are
duck-typed (`EnemyBrain` = anything with `tick(deps)`): the scheduled
`WaveDirector` and the economy `AIController` both fit.

**Rule for scripted beats:** no beat may gate a win without a timeout. Story
theater degrades to a notification; it never softlocks the mission.

### Sim/render separation & determinism

The simulation runs at a fixed **60 Hz** tick (`SIM_DT = 1/60`); the renderer
runs at `requestAnimationFrame`. A `simAccumulator` decouples them so frame-rate
never changes game speed. All sim-affecting randomness draws from a seeded
`Game.rng` (mulberry32) — never `Math.random` — so a saved game restores
faithfully. Render-side jitter (camera shake) may use `Math.random`.

### Unit FSM

Each unit is in exactly one state: `idle`, `moving`, `gathering`, `returning`,
`building`, `attacking`, or `attackMove`. Commands sit on a per-unit queue
(shift-click appends). Two rules keep crowds from deadlocking: intent completion
is *opportunistic* (a unit checks every tick whether its queued action is already
in range instead of insisting on an exact tile), and stuck units re-path once
with backoff before giving up.

## Agent API & headless mode

Game state is exposed on `window.rts.api` for scripted play (used by the
built-in AutoPlayer and by tests):

```js
const api = window.rts.api;
api.getState(); api.getResources(1); api.listEntities({ owner: 1, kind: 'unit' });
api.issueCommand(id, { kind: 'attack', targetId });
api.build('barracks', { tx, ty }, [builderId]);
api.train(buildingId, 'spearman');
api.castAbility(ramaId, 'brahmastra', { x, y });
api.canPlace('wall', { tx, ty });
api.pause(); api.resume(); api.setSpeed(8); api.step(1/60);
window.rts.quickSave(); window.rts.quickLoad();
window.rts.selectMission('yuddha-kanda'); window.rts.start();
```

URL params: `?skipintro=1` skips the cutscene, `?mission=<id>` jumps to a
mission, `?autopilot=1` runs the demo bot, `?speed=N` sets the multiplier,
`?headless=1` disables rendering/audio for fast sim-only runs.

## Multi-agent build system

This project ships with a small agent harness under `.claude/`:

- **agents/** — `rts-feature-dev` (implements a scoped feature end-to-end),
  `rts-playtester` (drives the game in a browser and reports defects),
  `rts-balance-judge` (headless balance analysis).
- **workflows/** — `review-and-fix` (four-dimension diff review with adversarial
  verification, then fixes), `playtest-matrix` (sequential browser playtests).

`PLAN.md` and `CAMPAIGN.md` document the roadmap and the mission/tech designs.

## Contributing

Contributions are welcome — new missions, art, balance passes, and features.
See [CONTRIBUTING.md](CONTRIBUTING.md) for where things live and the two rules
the engine relies on (determinism and no-softlocks). Good first issues: a new
mission (copy an existing `src/missions/*` file), a new blessing in
`src/config/techs.ts`, or replacing a procedural wall/gate with real art.

## Support & continue the journey

This game was built almost entirely by AI, and there's a lot more Ramayana to
tell (Kishkindha Kanda, the vanara allies, and beyond). If you'd like to help
it grow:

- **Build with us** — open a PR or an issue; the codebase is structured so new
  content is additive.
- **Sponsor** — the GitHub *Sponsor* button funds continued development
  (`.github/FUNDING.yml`).
- **Share it** — a star and a link help find collaborators.

## License

MIT — see [LICENSE](LICENSE). Do what you like; a credit is appreciated.

## Regenerating art

Sprite PNGs were generated with `gpt-image-2`. To regenerate missing assets:

```bash
OPENAI_API_KEY=sk-... node scripts/gen-images.mjs
```

Without a key argument the script only regenerates missing files. Walls, gates,
and campaign bosses render procedurally / by reusing base art, so no new assets
are required to play.
