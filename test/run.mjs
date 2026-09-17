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
  bcheck('birdie margin repr', String(BIRDIE_MARGIN), '0.05263157894736836')
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
