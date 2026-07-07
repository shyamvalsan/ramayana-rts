# Ramayana Campaign — Design

Synthesized from a three-designer panel (narrative / mechanics / scope-realist)
plus two judges. Skeleton: mechanics' wave pedagogy and siege tempo. Canon
beats grafted from the narrative design. Safety rules from the scope-realist:
**no scripted beat may gate a win without a timeout**, every boss has a
cut-the-boss fallback, and balance lives in single data knobs (`waveScale`,
`citadelHp`), not code.

## Mission I — Bala Kanda: "The Sacred Fire" (shipped, tuned)

Heroes-only defense of Vishwamitra's Yajna. 5 waves, one announced front each,
Tataka finale with enrage at half HP. Lose: Yajna, Rama, or Vishwamitra falls.
Win: Tataka dead and the field cleared.

## Mission II — Aranya Kanda: "The Hermitage at Panchavati"

Economy + defense. The player builds the exile settlement, then survives
Khara's vengeance.

- **Map**: forest clearings; Godavari water band along the south; hermitage
  (2x2, trains villagers, universal dropoff, LOSE if destroyed) center-south.
  Berries + deer near home; gold/stone in a contested clearing ON the northern
  raid lane — eco greed equals map-control risk.
- **Start**: Rama, Lakshmana, 4 villagers. Full build set (no stable).
- **Beats** (times scale with `waveScale`):
  - ~2:30 — Shurpanakha walk-in: one rakshasa walks W-edge → hermitage;
    proximity trigger → shake + "Lakshmana's blade flashes — Shurpanakha
    flees, disfigured, shrieking vengeance"; routs to the edge, timeout
    despawn. Pure theater, ~20 lines, cannot gate anything.
  - ~4:30 — Wave 1: **exactly 14 grunts** from the west (her fourteen
    rakshasas). Hero-solvable; teaches attack-move + astras.
  - ~7:30 — Wave 2: Dushana (grunt-def boss clone, ~400hp) + spears/archers.
    Demands first barracks; single-composition wave teaches the counter.
  - ~10:30 — Wave 3: Trisiras (fast boss clone, ~500hp) + cavalry mix.
    Punishes exposed villagers; teaches spearmen.
  - ~11:30 — **The Golden Deer** (optional, both branches converge): a golden
    deer wanders the NW. Kill it: +200 gold, but Maricha ambushes from the
    deer's clearing. Ignore it: Maricha joins the finale instead. Never gates
    the win.
  - ~13:30 — **Khara's host**: three staggered waves 40s apart from W, N, NE
    + Khara (subahu-scale boss, ~900hp). On his death every living rakshasa
    routs (move to nearest edge, timeout despawn) — "the host breaks."
- **Win**: Khara falls. Victory text is the dark hinge of the campaign:
  *"The hermitage stands empty. Sita is gone."* **Lose**: hermitage destroyed,
  Rama or Lakshmana falls, or all villagers dead before the first barracks
  (softlock guard).
- **Techs exposed**: Bala Mantra, Atibala Mantra, Sabari's Offering,
  Agastya's Armory, Agneyastra Tips, Vigil of Jatayu.

## Mission III — Yuddha Kanda: "The Siege of Lanka"

The dormant skirmish revived: full economy vs a prebuilt fortress.

- **Map**: sea channel severing the NE third; Lanka behind it; **Nala's Setu**
  — a 4-tile causeway — the only crossing. Player beachhead SW: town center,
  6 villagers, both heroes, 4 spearmen, 4 archers.
- **Lanka**: prebuilt citadel + economy + military buildings + watchtower ring
  (+ wall ring with a permanent 2-3 tile gap — *"the breach Hanuman burned"* —
  if Phase C walls land; tower ring alone otherwise). Fat stockpile,
  pre-assigned villagers, standing garrison.
- **Enemy brain**: parameterized AIController (faction typeIds + attack target
  from config, villager cap ~14, wave cadence 100s scaling) **plus** a
  scripted sortie timeline as the difficulty floor — pressure exists even if
  the economy AI stalls.
- **Boss ladder** (canon order):
  - ~5:00 **Prahasta** leads the first sortie across the causeway (~500hp).
  - **Kumbhakarna** wakes at first player damage to Lanka structures
    (fallback 16:00): ~1500hp siege-grade giant attack-moving the player TC.
    Kite, focus, Brahmastra.
  - **Indrajit & the Nagapasha**: 60s after Kumbhakarna falls — both heroes
    stunned 15s (fixed, tuned, scripted escort sortie — never a random AI
    wave) — released by *"Garuda descends on golden wings."* Indrajit
    (maricha-def clone, ~700hp) then holds the causeway gatefront. Bonus line
    if Lakshmana lands the kill.
  - **Ravana** at citadel <40% HP: ~1500hp, highest damage in the game, holds
    the citadel; **Aditya Hridayam** auto-unlocks free (the hymn before the
    duel: heroes +attack +regen).
- **Win**: citadel destroyed AND Ravana slain (order-agnostic).
  **Lose**: Rama or Lakshmana falls, or the player TC is destroyed.
- **Techs**: all ten, including III-only Indra's Kavacha, Nala's Masonry,
  Sanjivani Herb, Aditya Hridayam.

## Mission IV — Kishkindha Kanda (stretch, only if the night allows)

Heroes-only gauntlet following Sita's ornament trail (proximity predicates on
scattered "ornament" nodes), Shabari-style midpoint full-heal, ends meeting
the vanara teaser. Cut first if time is short.

## Tech tree ("Blessings") — Phase C

Research = ProductionOrder of kind 'tech' in the host building's queue.
Effects go through a per-player stat-modifier layer (`game.getStat`), never
def mutation (defs are shared by both factions). One headless assert per tech.

| Tech | Host | Cost / Time | Effect | Missions |
| --- | --- | --- | --- | --- |
| Bala Mantra | TC/Hermitage | 75F 50G / 30s | villager gather +20% | II, III |
| Atibala Mantra | TC (req. Bala) | 150F 100G / 40s | build speed +25%, vill +10hp | II, III |
| Sabari's Offering | Mill | 75F 75W / 30s | food gather +25% | II, III |
| Agastya's Armory | Barracks | 100F 50G / 40s | spear+cav +2 attack | II, III |
| Agneyastra Tips | Archery Range | 100W 75G / 40s | archers +3, heroes +2 attack | II, III |
| Vigil of Jatayu | Watchtower | 100W 75S / 45s | towers +2 dmg, +25% range/sight | II, III |
| Vayu's Swiftness | Stable | 125F 75G / 40s | cavalry +15% speed, +1 attack | III |
| Indra's Kavacha | Barracks | 200F 150G / 60s | all military +2 armor | III |
| Nala's Masonry | Mining Camp | 150W 100S / 45s | buildings +30% hp (walls/towers 2x) | III |
| Sanjivani Herb | Mill | 100F 100G / 25s | one-time instant full heal of both heroes | III |
| Aditya Hridayam | — | free, auto | heroes +6 attack, regen in combat | III (Ravana spawn) |

## Engine support checklist

- MissionDef framework + registry; per-mission win/lose/tick hooks; mission
  select on the title screen (chapter-grid pattern) with localStorage progress.
- Def-level `spriteKey` + `sizeScale` for boss reskins (Dushana/Trisiras/Khara/
  Kumbhakarna/Indrajit/Ravana reuse grunt/subahu/maricha/tataka art at scale;
  name banners over their heads).
- WaveDirector takes its wave table + `waveScale` per mission.
- AIController parameterized by faction config (typeIds, target predicate).
- Save/load: snapshot Game + director/AI state + missionId.
