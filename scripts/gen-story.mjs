#!/usr/bin/env node
// Calls OpenAI's chat completions API to draft a cohesive Ramayana cutscene
// script + matching image-gen prompts. Writes the result to scripts/story.json.
//
// Usage: OPENAI_API_KEY=sk-... node scripts/gen-story.mjs [--model gpt-5.5]
//
// The model is asked to return strict JSON with this shape:
//   {
//     "panels": [
//       {
//         "id": "cutscene-01",
//         "caption": "IN THE TRETA YUGA, ...",
//         "narration": "(longer prose for hover/expanded view, optional)",
//         "scene_prompt": "(detailed gpt-image-2 prompt — describe the
//           composition, characters, lighting, color palette, framing, and
//           include the embedded caption text instruction at the bottom band)"
//       },
//       ...
//     ],
//     "shared_style": "(2-3 sentence style guide that all panels reference
//        verbatim — sets palette, brushwork, lighting, framing, character
//        appearance consistency)"
//   }

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const OUT_PATH = path.join(ROOT, 'scripts', 'story.json');

async function loadEnv() {
  if (process.env.OPENAI_API_KEY) return;
  try {
    const data = await fs.readFile(ENV_PATH, 'utf-8');
    for (const line of data.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) process.env[m[1]] = m[2].trim();
    }
  } catch {}
}

const SYSTEM_PROMPT = `You are a cinematic narrative designer and concept-art prompt writer for an Age-of-Empires-style RTS game.

The game's tutorial campaign is the BALA KANDA of the Ramayana — specifically the episode where the sage Vishwamitra brings the young princes Rama and Lakshmana into the forest of Dandaka to PROTECT HIS YAJNA (sacred fire sacrifice) from the rakshasi Tataka and her demon sons Subahu and Maricha. The player commands Rama, Lakshmana, and a handful of villagers defending the Yajna site through waves of rakshasa attackers, with Tataka herself as the boss.

Write a cohesive 6-panel intro cutscene for THIS specific story. Return STRICT JSON with the shape described in the user message. No markdown fences. No commentary outside the JSON.

Tone: epic, mythological, dignified. Treat the player as the commander of Rama and Lakshmana — by panel 6 they are stepping into the role of defender of the Yajna.

For the scene prompts, follow these rules so the 6 panels look like they came from a single illustrated storybook:

1. Start every scene_prompt with the shared_style string verbatim, then the panel-specific description.
2. Character continuity (use these descriptions VERBATIM every time the character appears):
   - Rama: a noble young prince in a deep blue dhoti with gold jewelry, holding a great wooden longbow, long dark hair, calm steady eyes, a faint serene smile.
   - Lakshmana: a younger prince in a saffron-orange dhoti with silver bracelets, holding a curved bow and a short sword at his belt, similar dark hair to Rama, a more eager, alert expression.
   - Sage Vishwamitra: a tall white-bearded rishi in saffron-orange robes, a wooden staff in one hand, weathered face full of wisdom.
   - Tataka: a monstrous female rakshasi with dark blue-grey skin, long matted black hair, fangs and red glowing eyes, wearing crude bone ornaments and a tattered hide skirt, clawed hands, towering over normal demons.
   - Rakshasa minions: dark-red-skinned demons in spiked black armor with horned helmets.
   - The Yajna: a sacred fire burning on a stone altar inside a marked ritual ground, sometimes with Vishwamitra meditating beside it.
3. Composition: 16:9 cinematic widescreen, painterly oil-painting style, rich saturated color, warm golden light from upper-left UNLESS the scene is sinister (Tataka's forest or attack) — then cold blue and blood-red. Subjects always centered or rule-of-thirds composed. No text in the image except the caption band described below.
4. Caption: each panel has a translucent dark band across the BOTTOM of the image containing the panel's caption text rendered in clean elegant GOLD SERIF lettering. The text is large, readable, and clearly legible against the dark band. The band does not cover any character faces. Include this caption-band instruction in EVERY scene_prompt.
5. The 6 panels form a narrative arc specific to the Bala Kanda Yajna episode:
   1) Cosmic intro — the rakshasi Tataka and her sons disrupt sacred rites; sages flee or suffer.
   2) Vishwamitra approaches King Dasaratha in the Ayodhya court asking for Rama's help.
   3) Rama and Lakshmana leave Ayodhya with the sage, bows in hand.
   4) The sage establishes his Yajna in the forest; Rama and Lakshmana take guard positions; first signs of rakshasa scouts.
   5) The first wave of demons attacks the Yajna; Rama draws his bow.
   6) Tataka herself rises from the trees — call to the player: "Defend the Yajna."

Make the captions punchy and short (8-14 words). Make the narration a single sentence (15-30 words).`;

const USER_PROMPT = `Return strict JSON with exactly this shape (no other content):

{
  "shared_style": "...",
  "panels": [
    { "id": "cutscene-01", "caption": "...", "narration": "...", "scene_prompt": "..." },
    { "id": "cutscene-02", "caption": "...", "narration": "...", "scene_prompt": "..." },
    { "id": "cutscene-03", "caption": "...", "narration": "...", "scene_prompt": "..." },
    { "id": "cutscene-04", "caption": "...", "narration": "...", "scene_prompt": "..." },
    { "id": "cutscene-05", "caption": "...", "narration": "...", "scene_prompt": "..." },
    { "id": "cutscene-06", "caption": "...", "narration": "...", "scene_prompt": "..." }
  ]
}

Treat the captions as the actual rendered text in each image. Make sure each scene_prompt explicitly instructs the image generator to render that caption text in the image's bottom band, in gold serif lettering on a translucent dark band, large and clearly readable.`;

async function callOpenAI(model) {
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: USER_PROMPT },
    ],
    response_format: { type: 'json_object' },
  };
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI ${model} ${res.status}: ${txt.slice(0, 500)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('No content in response');
  return JSON.parse(content);
}

async function main() {
  await loadEnv();
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY');
    process.exit(1);
  }
  const modelArg = process.argv.indexOf('--model');
  const preferred = modelArg !== -1 ? process.argv[modelArg + 1] : null;
  const candidates = preferred ? [preferred] : ['gpt-5.5', 'gpt-5', 'gpt-4o', 'gpt-4-turbo'];
  let result = null;
  let usedModel = null;
  let lastErr = null;
  for (const m of candidates) {
    try {
      console.log(`Trying model: ${m}`);
      result = await callOpenAI(m);
      usedModel = m;
      break;
    } catch (e) {
      console.warn(`  failed: ${e.message.slice(0, 200)}`);
      lastErr = e;
    }
  }
  if (!result) {
    console.error('All models failed.');
    throw lastErr ?? new Error('no result');
  }
  console.log(`\nGenerated with: ${usedModel}`);
  console.log(`Panels: ${result.panels?.length ?? 0}`);
  console.log(`Shared style: ${(result.shared_style ?? '').slice(0, 120)}…\n`);
  for (const p of result.panels ?? []) {
    console.log(`[${p.id}] ${p.caption}`);
    console.log(`   ${p.narration}`);
    console.log();
  }
  await fs.writeFile(OUT_PATH, JSON.stringify({ model: usedModel, ...result }, null, 2));
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
