// Drift guard for verify.html.
//
// verify.html INLINES the verifier core (so it runs standalone from file://).
// This test extracts that inlined core, runs it against the golden vectors AND
// the shipped example, and fails if the inlined copy behaves differently from
// the engine. So the standalone page can never silently drift.
//
//   node test/check-inline.mjs

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const html = readFileSync(join(root, 'verify.html'), 'utf8')

// The inlined core lives between "INLINED verifier core" and the "─── UI ───" marker.
const start = html.indexOf('const R_DENOM')
const end = html.indexOf('// ─── UI')
if (start < 0 || end < 0 || end < start) {
  console.error('✗ could not locate the inlined core block in verify.html')
  process.exit(1)
}
const core = html.slice(start, end)
// HARDCODED export list — anything not named here is unreachable from this guard,
// so EVERY new inlined symbol must be added or it silently stops being drift-checked.
const mod =
  core +
  '\nexport { verifyCrashRound, verifyCountingRound, verifyMarbleRound, verifyRound, uniform, sha256Ascii, walkToRoot,' +
  ' crashMultiplier, draw13, vehicleBoundaries, weightsPpm, weightedPick, scaledIndex,' +
  ' permutationsIndex, marbleOrder, OUTCOME_ORDER, WEIGHT_SCALE }\n'

const tmp = join(here, '.inline-extract.mjs')
writeFileSync(tmp, mod)
let fail = 0
try {
  const m = await import(pathToFileURL(tmp).href)
  const V = JSON.parse(readFileSync(join(root, 'vectors', 'fairness-vectors.json'), 'utf8'))
  const eq = (name, got, want) => {
    if (got !== want) { fail++; console.log(`  ✗ ${name}\n      got ${got}\n      want ${want}`) }
  }

  // vectors: the inlined uniform / chain / crash must match the engine
  for (const d of V.draws) eq(`inline uniform(${d.label},${d.i})`, await m.uniform(d.server_seed, d.beacon, d.label, d.i), Number(d.r))
  for (const l of V.chain.links) eq(`inline walkToRoot(${l.index})`, await m.walkToRoot(l.server_seed, l.index), V.chain.root)
  for (const c of V.crash) eq(`inline crash(r=${c.r})`, m.crashMultiplier(Number(c.r), c.house_edge), c.crash_multiplier)

  // the shipped examples must verify green through the INLINED code
  const ex = JSON.parse(readFileSync(join(root, 'examples', 'crash-verified.json'), 'utf8'))
  const out = await m.verifyRound(ex)
  eq('inline example verdict', out.verdict, 'verified')
  eq('inline example multiplier', out.multiplier, 5.16)
  eq('inline example commitmentVerified', out.commitmentVerified, true)
  eq('inline example chainLinksToRoot', out.chainLinksToRoot, true)

  const cex = JSON.parse(readFileSync(join(root, 'examples', 'counting-verified.json'), 'utf8'))
  const cout = await m.verifyRound(cex)
  eq('inline counting example verdict', cout.verdict, 'verified')
  eq('inline counting example outcome', cout.outcome, 'under')
  eq('inline counting example bounds', `${cout.lowerBound}-${cout.upperBound}`, '16-19')
  eq('inline counting example commitmentVerified', cout.commitmentVerified, true)
  eq('inline counting example chainLinksToRoot', cout.chainLinksToRoot, true)

  const mex = JSON.parse(readFileSync(join(root, 'examples', 'marble-verified.json'), 'utf8'))
  const mout = await m.verifyRound(mex)
  eq('inline marble example verdict', mout.verdict, 'verified')
  eq('inline marble example order', mout.order.join(','), 'green,red,white')
  eq('inline marble example index', mout.index, 106)
  eq('inline marble example commitmentVerified', mout.commitmentVerified, true)
  eq('inline marble example chainLinksToRoot', mout.chainLinksToRoot, true)

  // vectors: the inlined counting mapper must match the engine too
  eq('inline OUTCOME_ORDER', m.OUTCOME_ORDER.join(','), 'under,range,over,jackpot')
  eq('inline WEIGHT_SCALE', m.WEIGHT_SCALE, 1000000)
  eq('inline scaledIndex(f…f, 1e6)', m.scaledIndex('fffffffffffff', 1000000), 999999)
  for (const v of V.vehicle_boundaries) {
    const got = await m.vehicleBoundaries(v.server_seed, v.probabilities, v.final_count, {
      beacon: v.beacon,
      gap: v.gap
    })
    eq(`inline vehicle[${v.note}] outcome`, got.outcome, v.outcome)
    eq(`inline vehicle[${v.note}] lower`, got.lowerBound, v.lower_bound)
    eq(`inline vehicle[${v.note}] upper`, got.upperBound, v.upper_bound)
    eq(`inline vehicle[${v.note}] outcomes`, got.outcomes.join(','), v.outcomes.join(','))
    eq(`inline vehicle[${v.note}] weights`, got.weightsPpm.join(','), v.weights_ppm.join(','))
    eq(`inline vehicle[${v.note}] draws`, JSON.stringify(got.draws), JSON.stringify(v.draws))
    const [order, w] = m.weightsPpm(v.probabilities)
    eq(`inline vehicle[${v.note}] weightedPick`, m.weightedPick(v.draws.outcome, order, w), v.outcome)
  }
  // the sum guard must throw in the inlined copy as well (never renormalise)
  let sumCode
  try { m.weightsPpm({ under: 0.3, range: 0.4, over: 0.25, jackpot: 0.04 }) } catch (e) { sumCode = e.code }
  eq('inline weight-sum guard', sumCode, 'WEIGHT_SUM')

  // vectors: the inlined marble mapper must match the engine too
  eq('inline permutationsIndex(3,2)', JSON.stringify(m.permutationsIndex(3, 2)), JSON.stringify([[0, 1], [0, 2], [1, 0], [1, 2], [2, 0], [2, 1]]))
  for (const v of V.marble_order) {
    const opts = { beacon: v.beacon }
    if (v.weights_ppm !== undefined) opts.weightsPpm = v.weights_ppm
    const got = await m.marbleOrder(v.server_seed, v.marbles, v.k, opts)
    eq(`inline marble[${v.note}] order`, got.order.join(','), v.order.join(','))
    eq(`inline marble[${v.note}] index`, got.index, v.index)
    eq(`inline marble[${v.note}] draw`, got.draw, v.draw)
  }

  // the inlined verifier must reach the SAME verdicts as src/ on every edge case
  // (this is where src and verify.html previously drifted).
  const { CASES, COUNTING_CASES, MARBLE_CASES, DISPATCH_CASES } = await import(
    pathToFileURL(join(here, 'verdict.mjs')).href
  )
  for (const [name, round, want] of CASES) {
    eq(`inline verdict: ${name}`, (await m.verifyCrashRound(round)).verdict, want)
  }
  for (const [name, round, want] of COUNTING_CASES) {
    eq(`inline verdict: ${name}`, (await m.verifyCountingRound(round)).verdict, want)
  }
  for (const [name, round, want] of MARBLE_CASES) {
    eq(`inline verdict: ${name}`, (await m.verifyMarbleRound(round)).verdict, want)
  }
  for (const [name, round, want] of DISPATCH_CASES) {
    eq(`inline verdict: ${name}`, (await m.verifyRound(round)).verdict, want)
  }
} finally {
  unlinkSync(tmp)
}

console.log(fail ? `\ninline drift check: ${fail} FAILED` : '✓ verify.html inlined core matches the engine + example')
process.exit(fail ? 1 : 0)
