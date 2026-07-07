export const meta = {
  name: 'playtest-matrix',
  description: 'Sequentially run rts-playtester agents over a list of scenarios (browser is shared, so no parallelism) and collect verdicts',
  whenToUse: 'After a feature batch integrates. Pass args = { scenarios: [{ name, url, objectives: [...] }] }. Requires vite dev server on 127.0.0.1:5173.',
  phases: [{ title: 'Playtest', detail: 'one browser-driving playtester per scenario, sequential' }],
}

const VERDICT = {
  type: 'object', required: ['pass', 'objectives', 'defects'],
  properties: {
    pass: { type: 'boolean' },
    objectives: { type: 'array', items: { type: 'object', required: ['objective', 'pass', 'note'], properties: { objective: { type: 'string' }, pass: { type: 'boolean' }, note: { type: 'string' } } } },
    defects: { type: 'array', items: { type: 'object', required: ['symptom', 'repro', 'severity'], properties: { symptom: { type: 'string' }, repro: { type: 'string' }, suspectedCause: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'major', 'minor'] }, screenshot: { type: 'string' } } } },
  },
}

const scenarios = (args && args.scenarios) || []
if (!scenarios.length) return { error: 'pass args.scenarios = [{name, url, objectives}]' }

phase('Playtest')
const results = []
for (const s of scenarios) {
  log(`playtesting: ${s.name}`)
  const r = await agent(
    `Playtest scenario "${s.name}". Open ${s.url} , call window.rts.start() via browser_evaluate, and verify each objective:\n${s.objectives.map((o, i) => `${i + 1}. ${o}`).join('\n')}\nUse setSpeed(8-16) + polling, screenshot and visually inspect key moments, and check the browser console for errors at the end.`,
    { label: `playtest:${s.name}`, phase: 'Playtest', schema: VERDICT, agentType: 'rts-playtester' })
  results.push({ scenario: s.name, ...(r || { pass: false, objectives: [], defects: [{ symptom: 'playtester agent died', repro: '-', severity: 'critical' }] }) })
}
return results
