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
  '\nexport { verifyCrashRound, verifyCountingRound, verifyMarbleRound, verifyBirdieRound, verifyRound, uniform, sha256Ascii, walkToRoot,' +
  ' crashMultiplier, draw13, vehicleBoundaries, weightsPpm, weightedPick, scaledIndex,' +
  ' permutationsIndex, marbleOrder, OUTCOME_ORDER, WEIGHT_SCALE,' +
  ' PATTERNS, BIRDIE_OPTIONS, BIRDIE_RTP_PPM, BIRDIE_MARGIN, ROUND_TYPES, patternWeightsPpm, countPpm, birdieBoard,' +
  ' paytableHash, hashTerm, cataloguePreimage, catalogueHash, birdieCard, roundTypeDraw, drawRoundType,' +
  ' redraw13, MAX_REDRAWS, rejectionThreshold, accepts, drawIndex, pickBucket, weightedPickSeeded }\n'

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

  // the shipped birdie example must verify green through the INLINED code
  const bex = JSON.parse(readFileSync(join(root, 'examples', 'birdie-verified.json'), 'utf8'))
  const bout = await m.verifyRound(bex)
  eq('inline birdie example verdict', bout.verdict, 'verified')
  eq('inline birdie example pattern', bout.pattern, 'MMM')
  eq('inline birdie example round type', bout.roundType, 'frost')
  eq('inline birdie example card', bout.cardEntryId, 'e02')
  eq('inline birdie example paytable', bout.paytableMatches, true)
  eq('inline birdie example commitmentVerified', bout.commitmentVerified, true)
  eq('inline birdie example chainLinksToRoot', bout.chainLinksToRoot, true)

  // vectors: the inlined birdie mappers must match the engine too
  const B = JSON.parse(readFileSync(join(root, 'vectors', 'birdie-vectors.json'), 'utf8'))
  const BAND = JSON.parse(readFileSync(join(root, 'vectors', 'birdie-weights-band.json'), 'utf8'))
  eq('inline BIRDIE_MARGIN', m.BIRDIE_MARGIN, B.margin)
  eq('inline PATTERNS', m.PATTERNS.join(','), B.patterns.join(','))
  eq('inline BIRDIE_OPTIONS', m.BIRDIE_OPTIONS.join(','), B.options.join(','))
  eq('inline ROUND_TYPES', m.ROUND_TYPES.join(','), B.round_types.join(','))
  for (const h of B.hash_term_vectors) eq(`inline hashTerm(${h.multiplier})`, m.hashTerm(h.multiplier), h.term)
  for (const v of B.boards) {
    const b = m.birdieBoard(v.make_rate_ppm)
    eq(`inline birdie board[${v.make_rate_ppm}] weights`, b.weightsPpm.join(','), v.weights_ppm.join(','))
    for (const o of m.BIRDIE_OPTIONS) eq(`inline birdie board[${v.make_rate_ppm}] ${o}`, b.multipliers[o], v.multipliers[o])
    eq(`inline birdie board[${v.make_rate_ppm}] preimage`, b.paytablePreimage, v.paytable_preimage)
    eq(`inline birdie board[${v.make_rate_ppm}] hash`, await m.paytableHash(v.make_rate_ppm), v.paytable_hash)
  }
  let bandMiss = 0
  for (const [ppm, weights] of Object.entries(BAND)) if (m.patternWeightsPpm(Number(ppm)).join(',') !== weights.join(',')) bandMiss++
  eq('inline birdie weights band', bandMiss, 0)
  const d = B.draws
  eq('inline birdie catalogueHash', await m.catalogueHash(d.catalogue_entries), d.catalogue_hash)
  const card = await m.birdieCard(d.server_seed, d.catalogue_entries)
  eq('inline birdie card', `${card.draw}/${card.entryId}/${card.index}`, `${d.card_draw}/${d.card_entry_id}/${d.card_index}`)
  const ord = await m.marbleOrder(d.server_seed, d.outcome_for_make_rate_300000.marbles, 1, { weightsPpm: m.patternWeightsPpm(300000) })
  eq('inline birdie order', `${ord.draw}/${ord.index}`, `${d.order_draw}/${d.outcome_for_make_rate_300000.index}`)
  for (const v of B.round_type_vectors) {
    const r = await m.drawRoundType(v.server_seed, v.weights_ppm)
    eq(`inline birdie round_type[${v.note}]`, `${r.draw}/${r.roundType}`, `${v.draw}/${v.round_type}`)
  }

  // RNG 1.1.0 (scheme 3): the inlined rejection sampling must match the engine too
  eq('inline MAX_REDRAWS', m.MAX_REDRAWS, 64)
  for (const a of V.accepts) {
    eq(`inline accepts[${a.note}] threshold`, m.rejectionThreshold(a.n), a.threshold)
    eq(`inline accepts[${a.note}] ${a.hex13}`, m.accepts(a.hex13, a.n), a.accepts)
    eq(`inline accepts[${a.note}] index`, m.scaledIndex(a.hex13, a.n), a.index)
  }
  for (const r of V.redraw13) eq(`inline redraw13(${r.preimage})`, await m.redraw13(r.server_seed, r.beacon, r.label, r.i, r.j), r.hex13)
  for (const d of V.draw_index) {
    const got = await m.drawIndex(d.server_seed, d.beacon, d.label, d.i, d.n)
    eq(`inline drawIndex[${d.note}]`, `${got.draw}/${got.redraws}/${got.accepted}/${got.index}`, `${d.draw}/${d.redraws}/${d.accepted}/${d.index}`)
  }
  for (const v of V.marble_order_v3) {
    const opts = { beacon: v.beacon, schemeVersion: v.scheme_version }
    if (v.weights_ppm !== undefined) opts.weightsPpm = v.weights_ppm
    const got = await m.marbleOrder(v.server_seed, v.marbles, v.k, opts)
    eq(`inline marble_v3[${v.note}]`, `${got.order.join(',')}/${got.index}/${got.draw}/${'redraws' in got}`, `${v.order.join(',')}/${v.index}/${v.draw}/false`)
  }
  for (const v of V.vehicle_boundaries_v3) {
    const got = await m.vehicleBoundaries(v.server_seed, v.probabilities, v.final_count, { beacon: v.beacon, gap: v.gap, schemeVersion: v.scheme_version })
    eq(`inline vehicle_v3[${v.note}]`, `${got.outcome}/${got.lowerBound}-${got.upperBound}/${JSON.stringify(got.draws)}/${'redraws' in got}`,
      `${v.outcome}/${v.lower_bound}-${v.upper_bound}/${JSON.stringify(v.draws)}/false`)
  }
  eq('inline pickBucket fallback', m.pickBucket(2, ['a', 'b'], [1, 1]), 'b')
  const ws = await m.weightedPickSeeded('ab'.repeat(32), '', 'outcome', 0, ['under', 'range', 'over', 'jackpot'], [300000, 400000, 250000, 50000])
  eq('inline weightedPickSeeded', `${ws.name}/${ws.index}/${ws.redraws}`, 'range/454163/0')
  let capCode
  try { await m.drawIndex('ab'.repeat(32), '', 'order', 0, 2 ** 52 + 1) } catch (e) { capCode = e.code }
  eq('inline drawIndex past MAX_REDRAWS throws', capCode, 'MAX_REDRAWS')
  // the rejection path end to end (Python reference values, test-only totals of 2^51+1)
  {
    const probs = { under: 0.3, range: 0.4, over: 0.25, jackpot: 0.05 }
    const v3 = await m.vehicleBoundaries('ab'.repeat(32), probs, 2 ** 52, { gap: 2 ** 51 + 2, schemeVersion: 3 })
    eq('inline v3 counting redraw', `${v3.lowerBound}-${v3.upperBound}/${JSON.stringify(v3.redraws)}/${JSON.stringify(v3.acceptedDraws)}`,
      '2985985849181974-5237785662867224/{"range_offset":3}/{"range_offset":"ac885fc4f71d2"}')
    const v2 = await m.vehicleBoundaries('ab'.repeat(32), probs, 2 ** 52, { gap: 2 ** 51 + 2 })
    eq('inline v2 counting, same seed', `${v2.lowerBound}-${v2.upperBound}/${'redraws' in v2}`, '3198603433912698-5450403247597948/false')
    const seed = '56c858f2b088359debfc994ef774b37ecf96871cceb2f132805e7290047d907d'
    const entries = [
      { entry_id: 'e01', golfer_id: 'g_tom', location_id: 'l_bangsaen', make_rate_ppm: 300000, weight_ppm: 2 ** 50 },
      { entry_id: 'e02', golfer_id: 'g_tom', location_id: 'l_hua_hin', make_rate_ppm: 500000, weight_ppm: 2 ** 50 + 1 }
    ]
    const c3 = await m.birdieCard(seed, entries, { schemeVersion: 3 })
    eq('inline v3 birdie card redraw', `${c3.entryId}/${c3.accepted}/${c3.redraws}/${c3.target}`, 'e02/beed50544faaa/2/1679411713834325')
    const t3 = await m.drawRoundType(seed, { none: 2 ** 50, frost: 2 ** 49, fire: 2 ** 49 + 1 }, { schemeVersion: 3 })
    eq('inline v3 birdie round_type redraw', `${t3.roundType}/${t3.accepted}/${t3.redraws}/${t3.target}`, 'fire/c38a63d8c4102/1/1719993184428161')
  }
  // every existing vector, handed to the INLINED verifier as a round, still verifies green
  const { vectorRounds, withScheme, SCHEMES } = await import(pathToFileURL(join(here, 'vector-rounds.mjs')).href)
  for (const [name, round] of vectorRounds(V)) {
    for (const [sname, scheme] of SCHEMES) eq(`inline verifyRound(${name}) ${sname}`, (await m.verifyRound(withScheme(round, scheme))).verdict, 'verified')
  }

  // the inlined verifier must reach the SAME verdicts as src/ on every edge case
  // (this is where src and verify.html previously drifted).
  const { CASES, COUNTING_CASES, MARBLE_CASES, BIRDIE_CASES, DISPATCH_CASES, V3_CASES } = await import(
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
  for (const [name, round, want] of BIRDIE_CASES) {
    eq(`inline verdict: ${name}`, (await m.verifyBirdieRound(round)).verdict, want)
  }
  for (const [name, round, want] of DISPATCH_CASES) {
    eq(`inline verdict: ${name}`, (await m.verifyRound(round)).verdict, want)
  }
  for (const [name, round, want] of V3_CASES) {
    eq(`inline verdict: ${name}`, (await m.verifyRound(round)).verdict, want)
  }
} finally {
  unlinkSync(tmp)
}

console.log(fail ? `\ninline drift check: ${fail} FAILED` : '✓ verify.html inlined core matches the engine + example')
process.exit(fail ? 1 : 0)
