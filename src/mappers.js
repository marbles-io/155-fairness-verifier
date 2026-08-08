// Per-game result mappers (v2) — dependency-free ES module. Locked by the vectors.

import * as core from './core.js'

// Half-up 2-decimal rounding: floor(x*100 + 0.5) / 100. Not Math.round/toFixed —
// the paid value must match the reference's floor(x*100+0.5)/100 exactly.
export function roundMultiplier(x) {
  return Math.floor(x * 100 + 0.5) / 100
}

// Crash point. The `max` clamp is applied before rounding; uncapped on the high side.
export function crashMultiplier(r, houseEdge = 0.06) {
  return roundMultiplier(Math.max(1.0, (1.0 - houseEdge) / (1.0 - r)))
}

// Uniform integer in [0, n): (int(hex13) * n) >> 52. Must use BigInt — the product
// overflows Number's 2^53 exact range, so a float multiply would mis-bucket.
export function scaledIndex(hex13, n) {
  return Number((BigInt('0x' + hex13) * BigInt(n)) >> BigInt(52))
}

// ── counting games ───────────────────────────────────────────────────────────
// finalCount is a reveal INPUT, not seed-derived; a verifier needs it to recompute
// the bounds. Everything else derives from the committed seed.

// Canonical outcome order. Never iterate the probabilities object — key order is
// not insertion order, and the cumulative selection depends on a fixed order.
export const OUTCOME_ORDER = ['under', 'range', 'over', 'jackpot']

// Integer parts-per-million so no float->int conversion is repeated and a
// distribution that doesn't sum to 1 fails loudly.
export const WEIGHT_SCALE = 1000000

// Canonically-ordered outcomes + integer ppm weights summing to WEIGHT_SCALE.
// A table that doesn't sum throws; never renormalise.
export function weightsPpm(probabilities) {
  const has = (o) => Object.prototype.hasOwnProperty.call(probabilities, o)
  const order = OUTCOME_ORDER.filter(has)
  const unknown = Object.keys(probabilities)
    .filter((k) => !OUTCOME_ORDER.includes(k))
    .sort()
  if (unknown.length) {
    const e = new Error(
      `unknown outcome(s) ${JSON.stringify(unknown)}; expected ${JSON.stringify(OUTCOME_ORDER)}`
    )
    e.code = 'UNKNOWN_OUTCOME'
    throw e
  }
  const w = order.map((o) => Math.floor(Number(probabilities[o]) * WEIGHT_SCALE + 0.5))
  const sum = w.reduce((a, b) => a + b, 0)
  if (sum !== WEIGHT_SCALE) {
    const e = new Error(`probabilities must sum to 1.0 (${WEIGHT_SCALE} ppm), got ${sum}`)
    e.code = 'WEIGHT_SUM'
    throw e
  }
  return [order, w]
}

// Pick a weighted outcome from a 52-bit draw using INTEGER cumulative buckets.
// No float touches the decision, so JS/Python/Go agree exactly. The target is
// scaled by the ACTUAL weight sum (not the constant) so this stays correct for
// any future scale. Bias vs a true uniform is 1e6 / 2**52 ~= 2.2e-10.
export function weightedPick(hex13, order, wPpm) {
  const total = wPpm.reduce((a, b) => a + b, 0)
  const target = scaledIndex(hex13, total)
  let cum = 0
  for (let i = 0; i < order.length; i++) {
    cum += wPpm[i]
    if (target < cum) return order[i]
  }
  return order[order.length - 1] // unreachable while the weights sum to the scale
}

// Seed -> { outcome, lowerBound, upperBound } for a counting round.
//
//   outcome      <- weightedPick over the "outcome" draw
//   under/over   <- offset 1..2 around the count
//   range        <- offset placing the count inside the gap (4-way strict, 3-way inclusive)
//   jackpot      <- which boundary the count is pinned to
//
// Every branch uses its own domain label at index 0, so adding a future draw can
// never shift an existing one, and `draws` ends up with exactly two entries:
// "outcome" plus the one branch label taken. `gap` is constant across outcomes.
export async function vehicleBoundaries(
  serverSeed,
  probabilities,
  finalCount,
  { beacon = '', gap = 3 } = {}
) {
  const [order, w] = weightsPpm(probabilities)
  const hasJackpot = Object.prototype.hasOwnProperty.call(probabilities, 'jackpot')
  const draws = {}
  const draw = async (label) => {
    const h = await core.draw13(serverSeed, beacon, label, 0)
    draws[label] = h
    return h
  }

  const outcomeHex = await draw('outcome')
  const outcome = weightedPick(outcomeHex, order, w)

  let lowerBound
  let upperBound
  if (outcome === 'under') {
    lowerBound = finalCount + 1 + scaledIndex(await draw('under_offset'), 2)
    upperBound = lowerBound + gap
  } else if (outcome === 'over') {
    upperBound = finalCount - (1 + scaledIndex(await draw('over_offset'), 2))
    lowerBound = upperBound - gap
  } else if (outcome === 'range') {
    const h = await draw('range_offset')
    // 4-way range is STRICTLY between the bounds; 3-way is INCLUSIVE of them.
    const offset = hasJackpot ? 1 + scaledIndex(h, gap - 1) : scaledIndex(h, gap + 1)
    lowerBound = finalCount - offset
    upperBound = lowerBound + gap
  } else {
    // jackpot — the count is pinned to a boundary
    if (scaledIndex(await draw('jackpot_side'), 2) === 0) {
      lowerBound = finalCount
      upperBound = finalCount + gap
    } else {
      lowerBound = finalCount - gap
      upperBound = finalCount
    }
  }

  // Defensive invariants, identical to the engine's generator. They must live
  // HERE (not in the caller) because a verifier has to reproduce the PUBLISHED
  // bounds, clamps and all.
  lowerBound = Math.max(1, lowerBound)
  upperBound = Math.max(lowerBound + gap, upperBound)

  // The weighted-bucket trace, so a UI can show WHY this outcome won.
  const total = w.reduce((a, b) => a + b, 0)
  let cum = 0
  const buckets = order.map((name, i) => {
    const from = cum
    cum += w[i]
    return { name, ppm: w[i], from, to: cum }
  })

  return {
    outcome,
    lowerBound,
    upperBound,
    gap,
    outcomes: order,
    weightsPpm: w,
    draws,
    outcomeHex13: outcomeHex,
    target: scaledIndex(outcomeHex, total),
    totalPpm: total,
    buckets
  }
}

// ── marble races (marble_order) ──────────────────────────────────────────────
// A round's outcome is an ordered finishing list of K names taken from M entrants
// (K == 1 single-winner, K == 3 podium). Fully seed-derived: one domain-separated
// draw picks an index into the canonical k-permutations of the entrants (equal) or
// a weighted bucket (weighted single-winner). The verifier re-enumerates itself.

// All k-permutations of range(m) in canonical lexicographic order. Built
// explicitly (not a library helper) so any port reproduces the exact same order.
export function permutationsIndex(m, k) {
  if (!(0 < k && k <= m)) {
    const e = new Error(`need 0 < k <= m, got m=${m} k=${k}`)
    e.code = 'MARBLE_KM'
    throw e
  }
  let result = [[]]
  for (let step = 0; step < k; step++) {
    const nxt = []
    for (const prefix of result) {
      for (let i = 0; i < m; i++) {
        if (!prefix.includes(i)) nxt.push(prefix.concat(i))
      }
    }
    result = nxt
  }
  return result
}

// Seed -> ordered finishing list for a marble round. A single domain-separated
// draw at label "order", index 0 decides the whole order.
//
//   equal    -> uniform index into the k-permutations of the entrant list
//   weighted -> weighted pick over the entrants (K == 1 only)
//
// `marbles` is the entrant universe for this round in canonical order. Returns the
// order plus everything a verifier needs to reproduce it.
export async function marbleOrder(serverSeed, marbles, k, { beacon = '', weightsPpm = null } = {}) {
  const m = marbles.length
  if (m === 0) {
    const e = new Error('marbles must be non-empty')
    e.code = 'MARBLE_EMPTY'
    throw e
  }
  if (!(0 < k && k <= m)) {
    const e = new Error(`need 0 < k <= m, got m=${m} k=${k}`)
    e.code = 'MARBLE_KM'
    throw e
  }

  const draw = await core.draw13(serverSeed, beacon, 'order', 0)

  if (weightsPpm !== null && weightsPpm !== undefined) {
    // Weighted mode is single-winner (K == 1) only; refuse a weighted podium loudly.
    if (k !== 1) {
      const e = new Error(`weighted marble_order supports only k=1, got k=${k}`)
      e.code = 'MARBLE_WEIGHTED_K'
      throw e
    }
    if (weightsPpm.length !== m) {
      const e = new Error(`weights_ppm must be index-aligned to marbles (${weightsPpm.length} vs ${m})`)
      e.code = 'MARBLE_WEIGHTS_LEN'
      throw e
    }
    const total = weightsPpm.reduce((a, b) => a + b, 0)
    if (total !== WEIGHT_SCALE) {
      // A table that doesn't sum throws; never renormalise.
      const e = new Error(`weights_ppm must sum to ${WEIGHT_SCALE}, got ${total}`)
      e.code = 'WEIGHT_SUM'
      throw e
    }
    const index = scaledIndex(draw, WEIGHT_SCALE)
    let cum = 0
    let picked = m - 1
    for (let i = 0; i < weightsPpm.length; i++) {
      cum += weightsPpm[i]
      if (index < cum) {
        picked = i
        break
      }
    }
    // The weighted-bucket trace, so a UI can show WHY this entrant won.
    let acc = 0
    const buckets = marbles.map((name, i) => {
      const from = acc
      acc += weightsPpm[i]
      return { name, ppm: weightsPpm[i], from, to: acc }
    })
    return {
      order: [marbles[picked]],
      marbles: [...marbles],
      k,
      weightsPpm: [...weightsPpm],
      draw,
      index: picked,
      target: index,
      totalPpm: total,
      buckets,
      weighted: true
    }
  }

  // Equal: uniform pick over the canonical k-permutations of the entrants.
  const perms = permutationsIndex(m, k)
  const index = scaledIndex(draw, perms.length)
  const order = perms[index].map((i) => marbles[i])
  return {
    order,
    marbles: [...marbles],
    k,
    draw,
    index,
    permCount: perms.length,
    weighted: false
  }
}
