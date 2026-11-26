// Conformance test. Runs the verifier's JS core against the canonical golden
// vectors. Exit non-zero on any drift.
//
//   node test/run.mjs
//
// If this passes, this JS reproduces the exact same numbers as the game engine.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as core from '../src/core.js'
import {
  crashMultiplier,
  roundMultiplier,
  scaledIndex,
  vehicleBoundaries,
  weightsPpm,
  weightedPick,
  permutationsIndex,
  marbleOrder,
  OUTCOME_ORDER,
  WEIGHT_SCALE
} from '../src/mappers.js'

const here = dirname(fileURLToPath(import.meta.url))
const V = JSON.parse(readFileSync(join(here, '..', 'vectors', 'fairness-vectors.json'), 'utf8'))

let pass = 0
let fail = 0
const fails = []
function check(name, got, want) {
  const ok = got === want
  if (ok) pass++
  else {
    fail++
    fails.push(`  ✗ ${name}\n      got:  ${got}\n      want: ${want}`)
  }
}

// --- chain: sha256Ascii link + walkToRoot ---------------------------------
for (const link of V.chain.links) {
  check(
    `chain sha256Ascii(seed[${link.index}])`,
    await core.sha256Ascii(link.server_seed),
    link.server_seed_hash
  )
  check(
    `chain walkToRoot(seed[${link.index}], ${link.index}) == root`,
    await core.walkToRoot(link.server_seed, link.index),
    V.chain.root
  )
}
// terminal seed walks the full length back to the root
check(
  `chain walkToRoot(terminal, ${V.chain.terminal_index}) == root`,
  await core.walkToRoot(V.chain.terminal, V.chain.terminal_index),
  V.chain.root
)

// --- draws: hmac_full / draw13 / uniform ----------------------------------
for (const d of V.draws) {
  check(`draw hmac(${d.preimage})`, await core.hmacSha256Hex(d.server_seed, d.preimage), d.hmac_full)
  check(`draw draw13(${d.label},${d.i})`, await core.draw13(d.server_seed, d.beacon, d.label, d.i), d.hex13)
  check(`draw uniform(${d.label},${d.i})`, await core.uniform(d.server_seed, d.beacon, d.label, d.i), Number(d.r))
}

// --- crash multiplier ------------------------------------------------------
for (const c of V.crash) {
  check(`crash mult(r=${c.r},edge=${c.house_edge})`, crashMultiplier(Number(c.r), c.house_edge), c.crash_multiplier)
}

// --- half-up round_multiplier ---------------------------------------------
for (const rm of V.round_multiplier) {
  check(`roundMultiplier(${rm.x})`, roundMultiplier(rm.x), rm.expected)
}

// --- vehicle_boundaries: counting games ------------------------------------
// The full mapper: canonical weights, the weighted outcome bucket, the branch
// offset draws and the clamp invariants. Every published field of every vector.
for (const v of V.vehicle_boundaries) {
  const got = await vehicleBoundaries(v.server_seed, v.probabilities, v.final_count, {
    beacon: v.beacon,
    gap: v.gap
  })
  const tag = `vehicle[${v.note}]`
  check(`${tag} outcome`, got.outcome, v.outcome)
  check(`${tag} lower_bound`, got.lowerBound, v.lower_bound)
  check(`${tag} upper_bound`, got.upperBound, v.upper_bound)
  check(`${tag} gap`, got.gap, v.gap)
  check(`${tag} outcomes`, got.outcomes.join(','), v.outcomes.join(','))
  check(`${tag} weights_ppm`, got.weightsPpm.join(','), v.weights_ppm.join(','))
  // EXACTLY two draws: "outcome" + the one branch label taken (never eager).
  check(`${tag} draw labels`, Object.keys(got.draws).sort().join(','), Object.keys(v.draws).sort().join(','))
  for (const [label, hex13] of Object.entries(v.draws)) {
    check(`${tag} draw13(${label})`, got.draws[label], hex13)
    // …and each one is the plain domain-separated core draw at index 0.
    check(`${tag} draw13(${label}) == core`, await core.draw13(v.server_seed, v.beacon, label, 0), hex13)
  }
  // the canonical order/weights are also reachable straight from the probabilities
  const [order, w] = weightsPpm(v.probabilities)
  check(`${tag} weightsPpm() order`, order.join(','), v.outcomes.join(','))
  check(`${tag} weightsPpm() ppm`, w.join(','), v.weights_ppm.join(','))
  check(`${tag} weightedPick()`, weightedPick(v.draws.outcome, order, w), v.outcome)
}

// --- marble_order: marble races --------------------------------------------
// The full mapper: a single "order" draw scaled to the k-permutation count
// (equal) or the weight total (weighted), then the finishing order. Every
// published field of every vector — order, index and draw all reproduced.
// M-permute-K = M! / (M-K)!  (the length permutationsIndex must enumerate).
const permCount = (m, k) => {
  let p = 1
  for (let i = 0; i < k; i++) p *= m - i
  return p
}
for (const v of V.marble_order) {
  const opts = { beacon: v.beacon }
  if (v.weights_ppm !== undefined) opts.weightsPpm = v.weights_ppm
  const got = await marbleOrder(v.server_seed, v.marbles, v.k, opts)
  const tag = `marble[${v.note}]`
  check(`${tag} order`, got.order.join(','), v.order.join(','))
  check(`${tag} index`, got.index, v.index)
  check(`${tag} draw`, got.draw, v.draw)
  // …and the draw is the plain domain-separated core draw at label "order", index 0.
  check(`${tag} draw == core`, await core.draw13(v.server_seed, v.beacon, 'order', 0), v.draw)
  check(`${tag} k`, got.k, v.k)
  check(`${tag} marbles`, got.marbles.join(','), v.marbles.join(','))
  if (v.weights_ppm !== undefined) {
    // weighted: index is the PICKED marble index, and marbles[index] is the winner.
    check(`${tag} weightsPpm`, got.weightsPpm.join(','), v.weights_ppm.join(','))
    check(`${tag} winner == marbles[index]`, got.marbles[got.index], v.order[0])
  } else {
    // equal: permutationsIndex enumerates exactly M!/(M-K)! entries in canonical order,
    // and the published index selects the published order out of it.
    const perms = permutationsIndex(v.marbles.length, v.k)
    check(`${tag} permutationsIndex length == M!/(M-K)!`, perms.length, permCount(v.marbles.length, v.k))
    check(`${tag} perms[index] -> order`, perms[v.index].map((i) => v.marbles[i]).join(','), v.order.join(','))
  }
}
// permutationsIndex is canonical lexicographic, built explicitly (not a library call).
check('permutationsIndex(3,2) canonical', JSON.stringify(permutationsIndex(3, 2)), JSON.stringify([[0, 1], [0, 2], [1, 0], [1, 2], [2, 0], [2, 1]]))
check('permutationsIndex(3,1) canonical', JSON.stringify(permutationsIndex(3, 1)), JSON.stringify([[0], [1], [2]]))
check('permutationsIndex(2,2) canonical', JSON.stringify(permutationsIndex(2, 2)), JSON.stringify([[0, 1], [1, 0]]))
// marbleOrder guards: k out of range, empty marbles, weighted with k!=1, bad weight sum.
for (const [label, fn, code] of [
  ['k>M throws', () => marbleOrder('aa'.repeat(32), ['a', 'b'], 3), 'MARBLE_KM'],
  ['k=0 throws', () => marbleOrder('aa'.repeat(32), ['a', 'b'], 0), 'MARBLE_KM'],
  ['empty marbles throws', () => marbleOrder('aa'.repeat(32), [], 1), 'MARBLE_EMPTY'],
  ['weighted k!=1 throws', () => marbleOrder('aa'.repeat(32), ['a', 'b'], 2, { weightsPpm: [500000, 500000] }), 'MARBLE_WEIGHTED_K'],
  ['weights not summing throws', () => marbleOrder('aa'.repeat(32), ['a', 'b'], 1, { weightsPpm: [500000, 400000] }), 'WEIGHT_SUM'],
  ['weights length mismatch throws', () => marbleOrder('aa'.repeat(32), ['a', 'b', 'c'], 1, { weightsPpm: [500000, 500000] }), 'MARBLE_WEIGHTS_LEN']
]) {
  let gotCode
  try {
    await fn()
  } catch (e) {
    gotCode = e.code
  }
  check(`marbleOrder ${label}`, gotCode, code)
}

// --- the weight-sum guard must throw, never renormalise --------------------
for (const bad of [
  { under: 0.3, range: 0.4, over: 0.25, jackpot: 0.04 }, // sums to 0.99
  { under: 0.3, range: 0.4, over: 0.25, jackpot: 0.06 }, // sums to 1.01
  { under: 0.5, range: 0.4 } // sums to 0.9
]) {
  let code
  try {
    weightsPpm(bad)
  } catch (e) {
    code = e.code
  }
  check(`weightsPpm rejects ${JSON.stringify(bad)}`, code, 'WEIGHT_SUM')
}
let unknownCode
try {
  weightsPpm({ under: 0.5, range: 0.4, sideways: 0.1 })
} catch (e) {
  unknownCode = e.code
}
check('weightsPpm rejects an unknown outcome name', unknownCode, 'UNKNOWN_OUTCOME')
check('OUTCOME_ORDER is append-only canonical', OUTCOME_ORDER.join(','), 'under,range,over,jackpot')
check('WEIGHT_SCALE', WEIGHT_SCALE, 1000000)

// weights_ppm must be canonically ordered no matter the key order handed in
// (JS object key order is NOT a contract — this is why we never iterate it).
{
  const shuffled = { jackpot: 0.05, over: 0.25, under: 0.3, range: 0.4 }
  const [order, w] = weightsPpm(shuffled)
  check('weightsPpm ignores object key order (names)', order.join(','), 'under,range,over,jackpot')
  check('weightsPpm ignores object key order (ppm)', w.join(','), '300000,400000,250000,50000')
}

// scaledIndex needs BigInt: n = 1e6 pushes the product to ~2^72.
check('scaledIndex(fff…, 1e6) stays in range', scaledIndex('fffffffffffff', 1000000), 999999)
check('scaledIndex(000…, 1e6)', scaledIndex('0000000000000', 1000000), 0)
check('scaledIndex(8000000000000, 1e6) == half', scaledIndex('8000000000000', 1000000), 500000)

// --- RNG 1.1.0: scheme_version 3, unbiased integer scaling (BMM DIRT.1001) --
// Lemire rejection on the unchanged multiply-shift: reject when the low 52 bits
// of x*n fall below 2^52 mod n, redraw with redraw13 (a 4-field preimage) until a
// draw accepts. Locked by the accepts / redraw13 / draw_index / *_v3 vectors.
{
  const M = await import('../src/mappers.js')
  const { verifyRound } = await import('../src/verify.js')
  const { vectorRounds, withScheme, SCHEMES } = await import('./vector-rounds.mjs')
  const codeOf = async (fn) => {
    try {
      await fn()
    } catch (e) {
      return e.code ?? e.message
    }
    return 'no throw'
  }

  check('MAX_REDRAWS', M.MAX_REDRAWS, 64)
  for (const a of V.accepts) {
    const tag = `accepts[${a.note}] ${a.hex13} n=${a.n}`
    check(`${tag} threshold`, M.rejectionThreshold(a.n), a.threshold)
    check(`${tag} accepts`, M.accepts(a.hex13, a.n), a.accepts)
    check(`${tag} index`, scaledIndex(a.hex13, a.n), a.index)
  }
  for (const r of V.redraw13) {
    const tag = `redraw13(${r.label},${r.i},${r.j})`
    check(`${tag} preimage`, `${r.beacon}:${r.label}:${r.i}:${r.j}`, r.preimage)
    // the expected value comes from an independent HMAC, not from redraw13 itself
    check(`${tag} == hmac(preimage)[:13]`, (await core.hmacSha256Hex(r.server_seed, r.preimage)).slice(0, 13), r.hex13)
    check(`${tag}`, await core.redraw13(r.server_seed, r.beacon, r.label, r.i, r.j), r.hex13)
    // a redraw never reuses a real draw: not (label, i), not i+1 (game-world / shot nonces), not i+j
    for (const i2 of [r.i, r.i + 1, r.i + r.j]) {
      check(`${tag} != draw13(i=${i2})`, (await core.draw13(r.server_seed, r.beacon, r.label, i2)) !== r.hex13, true)
    }
  }
  for (const d of V.draw_index) {
    const tag = `drawIndex[${d.note}]`
    const got = await M.drawIndex(d.server_seed, d.beacon, d.label, d.i, d.n)
    check(`${tag} draw (j=0)`, got.draw, d.draw)
    check(`${tag} redraws`, got.redraws, d.redraws)
    check(`${tag} accepted`, got.accepted, d.accepted)
    check(`${tag} index`, got.index, d.index)
    // restated from the spec: every draw before the accepted one rejects, the accepted one accepts
    let h = await core.draw13(d.server_seed, d.beacon, d.label, d.i)
    for (let j = 1; j <= d.redraws; j++) {
      check(`${tag} draw j=${j - 1} rejects`, M.accepts(h, d.n), false)
      h = await core.redraw13(d.server_seed, d.beacon, d.label, d.i, j)
    }
    check(`${tag} accepted draw accepts`, M.accepts(h, d.n), true)
    check(`${tag} restated accepted`, h, d.accepted)
    check(`${tag} restated index`, scaledIndex(h, d.n), d.index)
  }
  for (const v of V.marble_order_v3) {
    const tag = `marble_v3[${v.note}]`
    const opts = { beacon: v.beacon, schemeVersion: v.scheme_version }
    if (v.weights_ppm !== undefined) opts.weightsPpm = v.weights_ppm
    const got = await marbleOrder(v.server_seed, v.marbles, v.k, opts)
    check(`${tag} order`, got.order.join(','), v.order.join(','))
    check(`${tag} index`, got.index, v.index)
    check(`${tag} draw`, got.draw, v.draw)
    check(`${tag} no redraws key when nothing was rejected`, 'redraws' in got, false)
  }
  for (const v of V.vehicle_boundaries_v3) {
    const tag = `vehicle_v3[${v.note}]`
    const got = await vehicleBoundaries(v.server_seed, v.probabilities, v.final_count, { beacon: v.beacon, gap: v.gap, schemeVersion: v.scheme_version })
    check(`${tag} outcome`, got.outcome, v.outcome)
    check(`${tag} bounds`, `${got.lowerBound}-${got.upperBound}`, `${v.lower_bound}-${v.upper_bound}`)
    check(`${tag} weights_ppm`, got.weightsPpm.join(','), v.weights_ppm.join(','))
    check(`${tag} draws`, JSON.stringify(got.draws), JSON.stringify(v.draws))
    check(`${tag} no redraws key when nothing was rejected`, 'redraws' in got, false)
  }

  // v2 stays exactly as today: the default IS scheme 2, and on every existing vector
  // scheme 3 gives the identical result (no existing draw is ever rejected).
  for (const v of V.marble_order) {
    const base = { beacon: v.beacon }
    if (v.weights_ppm !== undefined) base.weightsPpm = v.weights_ppm
    const dflt = JSON.stringify(await marbleOrder(v.server_seed, v.marbles, v.k, base))
    check(`marble[${v.note}] scheme 2 == default`, JSON.stringify(await marbleOrder(v.server_seed, v.marbles, v.k, { ...base, schemeVersion: 2 })), dflt)
    check(`marble[${v.note}] scheme 3 == scheme 2`, JSON.stringify(await marbleOrder(v.server_seed, v.marbles, v.k, { ...base, schemeVersion: 3 })), dflt)
  }
  for (const v of V.vehicle_boundaries) {
    const base = { beacon: v.beacon, gap: v.gap }
    const dflt = JSON.stringify(await vehicleBoundaries(v.server_seed, v.probabilities, v.final_count, base))
    check(`vehicle[${v.note}] scheme 2 == default`, JSON.stringify(await vehicleBoundaries(v.server_seed, v.probabilities, v.final_count, { ...base, schemeVersion: 2 })), dflt)
    check(`vehicle[${v.note}] scheme 3 == scheme 2`, JSON.stringify(await vehicleBoundaries(v.server_seed, v.probabilities, v.final_count, { ...base, schemeVersion: 3 })), dflt)
  }
  // …and every existing vector, handed to the verifier as a round, still verifies green.
  for (const [name, round] of vectorRounds(V)) {
    for (const [sname, scheme] of SCHEMES) {
      check(`verifyRound(${name}) ${sname}`, (await verifyRound(withScheme(round, scheme))).verdict, 'verified')
    }
  }

  // pick_bucket: the integer cumulative walk, extracted; weighted_pick unchanged on top of it
  check('pickBucket first bucket', M.pickBucket(0, ['a', 'b'], [1, 1]), 'a')
  check('pickBucket second bucket', M.pickBucket(1, ['a', 'b'], [1, 1]), 'b')
  check('pickBucket falls back to the last entry', M.pickBucket(2, ['a', 'b'], [1, 1]), 'b')
  check('pickBucket returns the order element (not a string)', M.pickBucket(1, [10, 20, 30], [1, 1, 1]), 20)
  {
    const ws = await M.weightedPickSeeded('ab'.repeat(32), '', 'outcome', 0, ['under', 'range', 'over', 'jackpot'], [300000, 400000, 250000, 50000])
    check('weightedPickSeeded', `${ws.name}/${ws.index}/${ws.draw}/${ws.accepted}/${ws.redraws}`, 'range/454163/74440da90c26e/74440da90c26e/0')
  }

  // guards: fail closed on a bad n, j or scheme, before anything is drawn
  for (const n of [0, -1, 1.5, true, '3', NaN, 2 ** 53]) {
    check(`rejectionThreshold(${String(n)}) throws`, await codeOf(() => M.rejectionThreshold(n)), 'SCALE_N')
  }
  check('drawIndex n=0 throws', await codeOf(() => M.drawIndex('ab'.repeat(32), '', 'order', 0, 0)), 'SCALE_N')
  for (const j of [0, -1, 1.5, true, '1']) {
    check(`redraw13 j=${String(j)} throws`, await codeOf(() => core.redraw13('ab'.repeat(32), '', 'order', 0, j)), 'REDRAW_J')
  }
  check('redraw13 bad label throws', await codeOf(() => core.redraw13('ab'.repeat(32), '', 'Order', 0, 1)), 'bad label (^[a-z_]+$): Order')
  // n > 2^52 can never accept (only 2^52 draws exist): the cap burns the round instead of returning a biased index
  check('drawIndex past MAX_REDRAWS throws', await codeOf(() => M.drawIndex('ab'.repeat(32), '', 'order', 0, 2 ** 52 + 1)), 'MAX_REDRAWS')
  for (const sv of [1, 0, '3', true, 2.5]) {
    check(`marbleOrder schemeVersion=${String(sv)} throws`, await codeOf(() => marbleOrder('ab'.repeat(32), ['a', 'b'], 1, { schemeVersion: sv })), 'SCHEME_VERSION')
    check(`vehicleBoundaries schemeVersion=${String(sv)} throws`, await codeOf(() => vehicleBoundaries('ab'.repeat(32), { under: 0.5, over: 0.5 }, 5, { schemeVersion: sv })), 'SCHEME_VERSION')
  }

  // The rejection path end to end, against the Python reference engine
  // (155-game-engine fix/dirt-ith1195, fairness/mappers.py). Production n almost never
  // rejects, so these use test-only totals of 2^51+1, where P(reject) is about 1/2.
  {
    // counting: gap 2^51+2 makes the 4-way range_offset scale to gap-1 = 2^51+1
    const probs = { under: 0.3, range: 0.4, over: 0.25, jackpot: 0.05 }
    const opts = { gap: 2 ** 51 + 2 }
    const v3 = await vehicleBoundaries('ab'.repeat(32), probs, 2 ** 52, { ...opts, schemeVersion: 3 })
    check('v3 counting redraw: outcome', v3.outcome, 'range')
    check('v3 counting redraw: bounds', `${v3.lowerBound}-${v3.upperBound}`, '2985985849181974-5237785662867224')
    check('v3 counting redraw: draws are the j=0 draws', JSON.stringify(v3.draws), JSON.stringify({ outcome: '74440da90c26e', range_offset: '945c63516ad09' }))
    check('v3 counting redraw: redraws {label: j}', JSON.stringify(v3.redraws), JSON.stringify({ range_offset: 3 }))
    check('v3 counting redraw: accepted draw', JSON.stringify(v3.acceptedDraws), JSON.stringify({ range_offset: 'ac885fc4f71d2' }))
    const v2 = await vehicleBoundaries('ab'.repeat(32), probs, 2 ** 52, { ...opts, schemeVersion: 2 })
    check('v2 counting, same seed: bounds (no rejection)', `${v2.lowerBound}-${v2.upperBound}`, '3198603433912698-5450403247597948')
    check('v2 counting, same seed: no redraws key', 'redraws' in v2, false)

    // birdie card and round type: weights summing to 2^51+1 (draw_index at n = sum(w), then pick_bucket)
    const seed = '56c858f2b088359debfc994ef774b37ecf96871cceb2f132805e7290047d907d'
    const entries = [
      { entry_id: 'e01', golfer_id: 'g_tom', location_id: 'l_bangsaen', make_rate_ppm: 300000, weight_ppm: 2 ** 50 },
      { entry_id: 'e02', golfer_id: 'g_tom', location_id: 'l_hua_hin', make_rate_ppm: 500000, weight_ppm: 2 ** 50 + 1 }
    ]
    const c3 = await M.birdieCard(seed, entries, { schemeVersion: 3 })
    check('v3 birdie card redraw', `${c3.entryId}/${c3.index}/${c3.draw}/${c3.accepted}/${c3.redraws}/${c3.target}`, 'e02/1/758f351ff7aa2/beed50544faaa/2/1679411713834325')
    check('v2 birdie card, same seed', (await M.birdieCard(seed, entries)).entryId, 'e01')
    const rtw = { none: 2 ** 50, frost: 2 ** 49, fire: 2 ** 49 + 1 }
    const t3 = await M.drawRoundType(seed, rtw, { schemeVersion: 3 })
    check('v3 birdie round_type redraw', `${t3.roundType}/${t3.draw}/${t3.accepted}/${t3.redraws}/${t3.target}`, 'fire/bee16e4749787/c38a63d8c4102/1/1719993184428161')
    check('v2 birdie round_type, same seed', (await M.drawRoundType(seed, rtw)).roundType, 'frost')
  }
}

console.log(`\nfairness-vectors conformance: ${pass} passed, ${fail} failed`)
if (fail) {
  console.log('\n' + fails.join('\n'))
  process.exit(1)
}
console.log('✓ this JS reproduces the engine byte-for-byte\n')

// ── birdie: dynamic-odds golf ────────────────────────────────────────────────
// Locked to vectors/birdie-vectors.json (generated by the game engine, shared with
// the Go backend) and vectors/birdie-weights-band.json (the backend's 701-point band
// table). Three independent draws over one seed.
{
  const {
    PATTERNS, BIRDIE_OPTIONS, BIRDIE_RTP_PPM, BIRDIE_MARGIN, ROUND_TYPES,
    patternWeightsPpm, countPpm, birdieBoard, paytableHash, hashTerm,
    cataloguePreimage, catalogueHash, birdieCard, roundTypeDraw, drawRoundType
  } = await import('../src/mappers.js')
  const B = JSON.parse(readFileSync(join(here, '..', 'vectors', 'birdie-vectors.json'), 'utf8'))
  const BAND = JSON.parse(readFileSync(join(here, '..', 'vectors', 'birdie-weights-band.json'), 'utf8'))

  let bpass = 0
  let bfail = 0
  const bcheck = (name, got, want) => {
    if (got === want) bpass++
    else {
      bfail++
      fails.push(`  ✗ ${name}\n      got:  ${got}\n      want: ${want}`)
    }
  }

  bcheck('birdie rtp_ppm', BIRDIE_RTP_PPM, B.rtp_ppm)
  bcheck('birdie margin (one literal on every side)', BIRDIE_MARGIN, B.margin)
  bcheck('birdie margin repr', String(BIRDIE_MARGIN), '0.06382978723404253')
  bcheck('birdie: a round priced at 950000 (before 2026-09-21) still hashes as it did', await paytableHash(500000, 950000), '468afe9bc9bee5d15a55c2dc32eefeeddf92d157c86613a59ccd6d8b26bb9bcc')
  bcheck('birdie: the default rtp is the constant', await paytableHash(500000), await paytableHash(500000, BIRDIE_RTP_PPM))
  bcheck('birdie PATTERNS', PATTERNS.join(','), B.patterns.join(','))
  bcheck('birdie OPTIONS', BIRDIE_OPTIONS.join(','), B.options.join(','))
  bcheck('birdie ROUND_TYPES', ROUND_TYPES.join(','), B.round_types.join(','))
  for (const h of B.hash_term_vectors) bcheck(`birdie hashTerm(${h.multiplier})`, hashTerm(h.multiplier), h.term)

  // the four vector boards: weights, counts, every multiplier BIT-equal, preimage and hash
  for (const v of B.boards) {
    const tag = `birdie board[${v.make_rate_ppm}]`
    const b = birdieBoard(v.make_rate_ppm)
    bcheck(`${tag} weights_ppm`, b.weightsPpm.join(','), v.weights_ppm.join(','))
    bcheck(`${tag} weights sum`, b.weightsPpm.reduce((a, c) => a + c, 0), 1000000)
    bcheck(`${tag} count_ppm`, JSON.stringify(b.countPpm), JSON.stringify(v.count_ppm))
    for (const o of BIRDIE_OPTIONS) bcheck(`${tag} multiplier ${o}`, b.multipliers[o], v.multipliers[o])
    bcheck(`${tag} paytable_preimage`, b.paytablePreimage, v.paytable_preimage)
    bcheck(`${tag} paytable_hash`, await paytableHash(v.make_rate_ppm), v.paytable_hash)
  }
  // the 701-point band table, every weight bit for bit
  let bandMiss = 0
  for (const [ppm, weights] of Object.entries(BAND)) {
    if (patternWeightsPpm(Number(ppm)).join(',') !== weights.join(',')) bandMiss++
  }
  bcheck(`birdie weights band table (${Object.keys(BAND).length} make rates)`, bandMiss, 0)
  bcheck('birdie make rate clamps low', patternWeightsPpm(10000).join(','), patternWeightsPpm(150000).join(','))
  bcheck('birdie make rate clamps high', patternWeightsPpm(990000).join(','), patternWeightsPpm(850000).join(','))
  bcheck('birdie countPpm sums its patterns', JSON.stringify(countPpm(B.boards[0].weights_ppm)), JSON.stringify(B.boards[0].count_ppm))

  // the draws on the vector seed: card, order and round type are THREE labels, all different
  const d = B.draws
  bcheck('birdie card draw == core draw13(card)', await core.draw13(d.server_seed, '', 'card', 0), d.card_draw)
  bcheck('birdie order draw == core draw13(order)', await core.draw13(d.server_seed, '', 'order', 0), d.order_draw)
  bcheck('birdie round_type draw == core draw13(round_type)', await core.draw13(d.server_seed, '', 'round_type', 0), d.round_type_draw)
  bcheck('birdie three labels differ', new Set([d.card_draw, d.order_draw, d.round_type_draw]).size, 3)
  bcheck('birdie cataloguePreimage', cataloguePreimage([...d.catalogue_entries].reverse()), d.catalogue_preimage)
  bcheck('birdie catalogueHash (input order irrelevant)', await catalogueHash([...d.catalogue_entries].reverse()), d.catalogue_hash)
  const card = await birdieCard(d.server_seed, d.catalogue_entries)
  bcheck('birdie card draw', card.draw, d.card_draw)
  bcheck('birdie card entry', card.entryId, d.card_entry_id)
  bcheck('birdie card index', card.index, d.card_index)
  const o = d.outcome_for_make_rate_300000
  const got = await marbleOrder(d.server_seed, o.marbles, 1, { weightsPpm: patternWeightsPpm(300000) })
  bcheck('birdie order (make rate 300000)', got.order.join(','), o.order.join(','))
  bcheck('birdie order index', got.index, o.index)
  bcheck('birdie order draw', got.draw, d.order_draw)
  bcheck('birdie pattern name', PATTERNS[got.index], 'MMM')
  bcheck('birdie round_type draw', await roundTypeDraw(d.server_seed), d.round_type_draw)
  const rt = await drawRoundType(d.server_seed, d.round_type.weights_ppm)
  bcheck('birdie round_type', rt.roundType, d.round_type.round_type)
  bcheck('birdie round_type draw (via mapper)', rt.draw, d.round_type_draw)
  for (const v of B.round_type_vectors) {
    const r = await drawRoundType(v.server_seed, v.weights_ppm)
    bcheck(`birdie round_type[${v.note}] draw`, r.draw, v.draw)
    bcheck(`birdie round_type[${v.note}] type`, r.roundType, v.round_type)
  }
  bcheck('birdie round_type vectors cover every bucket', new Set(B.round_type_vectors.map((v) => v.round_type)).size, ROUND_TYPES.length)
  // guards: bad round-type weights throw, an empty catalogue throws
  let code
  try { await drawRoundType(d.server_seed, { none: 0, frost: 0, fire: 0 }) } catch (e) { code = e.code }
  bcheck('birdie zero-sum round_type weights throw', code, 'ROUND_TYPE_WEIGHTS')
  code = undefined
  try { await drawRoundType(d.server_seed, { none: 800000, frost: -1 }) } catch (e) { code = e.code }
  bcheck('birdie negative round_type weight throws', code, 'ROUND_TYPE_WEIGHTS')
  code = undefined
  try { await birdieCard(d.server_seed, []) } catch (e) { code = e.code }
  bcheck('birdie empty catalogue throws', code, 'CATALOGUE_EMPTY')

  console.log(`birdie-vectors conformance: ${bpass} passed, ${bfail} failed`)
  if (bfail) {
    console.log('\n' + fails.join('\n'))
    process.exit(1)
  }
  console.log('✓ this JS reproduces the birdie engine byte-for-byte\n')
}
