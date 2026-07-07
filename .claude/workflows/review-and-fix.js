export const meta = {
  name: 'review-and-fix',
  description: 'Review the current uncommitted diff of the RTS across four dimensions, adversarially verify findings, fix the confirmed ones',
  whenToUse: 'After landing a feature batch, before committing. Reviews `git diff HEAD` (staged + unstaged).',
  phases: [
    { title: 'Review', detail: 'four parallel dimension reviewers' },
    { title: 'Verify', detail: 'adversarial refutation per finding' },
    { title: 'Fix', detail: 'apply confirmed fixes sequentially' },
  ],
}

const FINDINGS = {
  type: 'object', required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', required: ['file', 'line', 'title', 'detail', 'severity'],
        properties: {
          file: { type: 'string' }, line: { type: 'number' },
          title: { type: 'string' }, detail: { type: 'string', description: 'failure scenario: inputs/state -> wrong behavior' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
        },
      },
    },
  },
}
const VERDICT = {
  type: 'object', required: ['refuted', 'reason'],
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
}

const REPO = '/home/shyam/projects/rts'
const DIMENSIONS = [
  { key: 'sim-correctness', prompt: 'simulation correctness: state machines, tick order, dead-entity handling, resource accounting, off-by-one in tile math, NaN/undefined propagation' },
  { key: 'determinism-save', prompt: 'determinism and serializability: wall-clock reads in sim code, Math.random in sim paths without a seeded RNG, non-serializable state (closures, DOM refs) inside Game, iteration-order dependence' },
  { key: 'render-ui', prompt: 'rendering and UI: draw order, fog-of-war leaks (enemy info visible when it should not be), stale DOM after state changes, event-listener leaks on restart, canvas transforms not restored' },
  { key: 'perf-gc', prompt: 'performance: per-tick or per-frame allocations in hot loops, O(n^2) entity scans that grow with army size, repeated full-map iterations that could early-exit' },
]

phase('Review')
const results = await pipeline(
  DIMENSIONS,
  d => agent(
    `Review the current uncommitted diff in ${REPO} (run: git -C ${REPO} diff HEAD, plus git -C ${REPO} status --short for new files — read new files in full). This is an AoE2-style RTS: fixed 60Hz sim tick decoupled from rendering; Game owns all state; systems are pure-ish per-tick functions. Focus ONLY on ${d.prompt}. Read enough surrounding unchanged code to judge in context. Report only defects you can articulate a concrete failure scenario for.`,
    { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS }),
  (review, d) => review ? parallel(review.findings.map(f => () =>
    agent(
      `In ${REPO}, adversarially verify this ${d.key} code-review finding. Read the actual code at ${f.file}:${f.line} and its callers. Finding: "${f.title}" — ${f.detail}. Try hard to REFUTE it (is the scenario actually reachable? does other code guard it?). If uncertain after reading, refuted=false only when you can restate a concrete reachable failure.`,
      { label: `verify:${f.title.slice(0, 40)}`, phase: 'Verify', schema: VERDICT }
    ).then(v => ({ ...f, verdict: v })))) : [],
)

const confirmed = results.flat().filter(Boolean).filter(f => f.verdict && !f.verdict.refuted)
log(`${confirmed.length} confirmed findings`)
if (confirmed.length === 0) return { confirmed: [], fixed: false }

phase('Fix')
const fixReport = await agent(
  `In ${REPO}, fix each of these confirmed code-review findings in the working tree. After all fixes run npx tsc -b --noEmit and make it pass. Findings (JSON): ${JSON.stringify(confirmed.map(({ verdict, ...f }) => f))}. If a finding is wrong once you read the code, skip it and say why. Report per finding: fixed/skipped + one-line summary.`,
  { label: 'fix-all', phase: 'Fix' })

return { confirmed, fixReport }
