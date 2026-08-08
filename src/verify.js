// Game-agnostic round verifier — the reusable "provably fair model."
// 1:1 port of the reference verify.ts. Any 155 game reuses verifyCommitment +
// deriveR and supplies only its r -> result mapping (crash below).

import * as core from './core.js'
import { crashMultiplier, vehicleBoundaries, marbleOrder, OUTCOME_ORDER, WEIGHT_SCALE } from './mappers.js'

const R_DENOM = 2 ** 52

// The `game` discriminators. ABSENT (or anything else) means crash — the original
// contract, which must never break.
export const COUNTING_GAME = 'vehicle_boundaries'
export const MARBLE_GAME = 'marble_order'

// ── shared input normalisation ───────────────────────────────────────────────
// Every field arrives as a string (URL param / form input) or a JSON value, so
// blank-vs-absent-vs-garbage has to be decided in ONE place. verify.html inlines
// the identical helpers; test/check-inline.mjs re-locks them.

// "supplied" means: not null/undefined AND not blank once trimmed. A whitespace-
// only value is NOT a value — it must never be coerced (Number('  ') === 0 would
// silently walk the chain 0 times and then call a good round a mismatch).
function isSupplied(v) {
  return v != null && String(v).trim() !== ''
}

function trimLower(v) {
  return String(v).trim().toLowerCase()
}

// Strict integer parse of a supplied field: returns undefined when not supplied,
// NaN when supplied but not a whole number. NEVER coerces '', '  ', '7.5', '1e3'.
function intOrNaN(v) {
  if (!isSupplied(v)) return undefined
  const s = String(v).trim()
  if (!/^[+-]?\d+$/.test(s)) return NaN
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : NaN
}

// Verify the per-round commitment and (v2) the hash-chain linkage. Game-agnostic.
//   proof: { schemeVersion, serverSeed, nonce?, observedCommitment?, beacon?,
//            chainRootHash?, chainIndex? }
// Returns { schemeVersion, recomputedCommitment, commitmentVerified, chainLinksToRoot }.
//   commitmentVerified: true = the pre-round commitment matches; false = mismatch;
//     undefined = no pre-round commitment supplied, so "committed before you bet"
//     cannot be independently certified (an honest UNPROVEN, not a pass).
//   chainLinksToRoot: v2 only — sha256^chainIndex(seed) === chainRootHash.
export async function verifyCommitment(proof) {
  const v2 = proof.schemeVersion >= 2
  const recomputedCommitment = v2
    ? await core.sha256Ascii(proof.serverSeed) // v2: commitment == the chain link
    : await core.sha256Ascii(`${proof.serverSeed}:${proof.nonce ?? ''}`) // v1: binds seed AND nonce

  const observed = isSupplied(proof.observedCommitment)
    ? trimLower(proof.observedCommitment)
    : undefined
  const commitmentVerified = observed !== undefined ? recomputedCommitment === observed : undefined

  let chainLinksToRoot
  let walked
  // A blank/whitespace-only root is NOT a root — treat it as "not supplied", the
  // same way a blank chainIndex is, so it can never manufacture a false red.
  const root = isSupplied(proof.chainRootHash) ? trimLower(proof.chainRootHash) : undefined
  // Number.isInteger (not typeof === 'number') so NaN / a bad index is "not
  // checked" (undefined), never a silent walkToRoot(seed, 0) or 0-iteration walk.
  if (v2 && root && Number.isInteger(proof.chainIndex)) {
    walked = await core.walkToRoot(proof.serverSeed, proof.chainIndex)
    chainLinksToRoot = walked === root
  }

  return {
    schemeVersion: proof.schemeVersion,
    recomputedCommitment,
    observed,
    commitmentVerified,
    chainLinksToRoot,
    walked,
    root
  }
}

// Derive the uniform r for a game's draw. v2 uses the domain-separated core
// (label selects the draw, e.g. "crash"); v1 uses HMAC(seed, nonce).
export async function deriveR(proof, label, index = 0) {
  if (proof.schemeVersion >= 2) return core.uniform(proof.serverSeed, proof.beacon ?? '', label, index)
  const hex13 = (await core.hmacSha256Hex(proof.serverSeed, proof.nonce ?? '')).slice(0, 13)
  return parseInt(hex13, 16) / R_DENOM
}

function hexFromR(r) {
  return Math.floor(r * R_DENOM)
    .toString(16)
    .padStart(13, '0')
}

// High-level crash-round verifier. Input is a round's PUBLIC values:
//   { serverSeed, schemeVersion=2, chainRootHash, chainIndex, beacon="",
//     houseEdge=0.06, multiplier, observedCommitment }
// observedCommitment is the value published at round OPEN (the commitment) —
// supply it to prove the outcome was fixed BEFORE betting closed.
//
// Verdict:
//   'mismatch'     — any check explicitly failed (someone is lying about this round).
//   'verified'     — the recomputation reproduces the result AND the pre-round
//                    commitment matches (fixed before you bet).
//   'inconclusive' — the result reproduces and (v2) the seed links to the given
//                    root, but no pre-round commitment was supplied, so we cannot
//                    prove it was fixed BEFORE betting. Honest amber, never green.
export async function verifyCrashRound(round) {
  const chainIndex = intOrNaN(round.chainIndex)
  const proof = {
    schemeVersion: round.schemeVersion ?? 2,
    serverSeed: String(round.serverSeed || '').trim().toLowerCase(),
    nonce: round.nonce,
    beacon: round.beacon ?? '',
    chainRootHash: round.chainRootHash,
    chainIndex,
    observedCommitment: round.observedCommitment
  }

  // Malformed seed -> a typed error the UI can show, never a false verdict.
  if (!/^[0-9a-f]+$/i.test(proof.serverSeed) || proof.serverSeed.length % 2 !== 0) {
    return { verdict: 'error', error: 'The revealed seed must be an even-length hex string.' }
  }
  // A chain index that was supplied but is not a whole number >= 0 is garbage in,
  // so we refuse to verify at all rather than quietly skipping the chain check
  // (skipping is only ever correct when the index was NOT supplied).
  if (chainIndex !== undefined && !(Number.isInteger(chainIndex) && chainIndex >= 0)) {
    return { verdict: 'error', error: 'The chain index must be a whole number of 0 or more.' }
  }

  const commit = await verifyCommitment(proof)
  const r = await deriveR(proof, 'crash', 0)
  const heRaw = round.houseEdge != null && String(round.houseEdge).trim() !== '' ? Number(round.houseEdge) : 0.06
  const houseEdge = Number.isFinite(heRaw) ? heRaw : 0.06
  const multiplier = crashMultiplier(r, houseEdge)
  const published =
    round.multiplier != null && String(round.multiplier).trim() !== '' ? Number(round.multiplier) : undefined
  const multiplierMatches = published !== undefined ? multiplier === published : undefined

  let verdict
  if (
    commit.commitmentVerified === false ||
    multiplierMatches === false ||
    commit.chainLinksToRoot === false
  ) {
    verdict = 'mismatch'
  } else if (commit.commitmentVerified === true && multiplierMatches === true) {
    // GREEN requires BOTH: the pre-round commitment matches AND the published
    // result was reproduced. Commitment-alone (no result cross-check) is amber —
    // otherwise an operator could reveal a matching seed yet pay a different curve.
    verdict = 'verified'
  } else {
    verdict = 'inconclusive'
  }

  return {
    verdict,
    game: 'crash',
    schemeVersion: proof.schemeVersion,
    r,
    hex13: hexFromR(r),
    multiplier,
    publishedMultiplier: published,
    multiplierMatches,
    recomputedCommitment: commit.recomputedCommitment,
    observed: commit.observed,
    commitmentVerified: commit.commitmentVerified,
    chainLinksToRoot: commit.chainLinksToRoot,
    walked: commit.walked,
    root: commit.root,
    chainIndex: proof.chainIndex,
    houseEdge
  }
}

// ── counting games (vehicle_boundaries) ──────────────────────────────────────
//
// High-level counting-round verifier. Input is a round's PUBLIC values:
//   { game: 'vehicle_boundaries', serverSeed, observedCommitment, chainRootHash,
//     chainIndex, beacon = '', finalCount, gap = 3,
//     outcome, lowerBound, upperBound,            <- the PUBLISHED result
//     outcomes: 'under,range,over,jackpot',       <- csv or array (canonical order)
//     weightsPpm: '300000,400000,250000,50000' }  <- csv or array, index-aligned
// `probabilities` (an object) may be supplied instead of outcomes/weightsPpm.
//
// Verdict rules mirror crash exactly:
//   'verified'     — commitment matches AND outcome + BOTH bounds reproduce.
//   'mismatch'     — any check explicitly failed (incl. weights that don't sum).
//   'inconclusive' — consistent so far, but the commitment or the published
//                    result wasn't supplied, so nothing is certified. Never green.
//   'error'        — an input needed for the recomputation is missing/malformed.
export async function verifyCountingRound(round) {
  const seed = String(round.serverSeed || '').trim().toLowerCase()
  if (!/^[0-9a-f]+$/i.test(seed) || seed.length % 2 !== 0) {
    return { verdict: 'error', game: COUNTING_GAME, error: 'The revealed seed must be an even-length hex string.' }
  }

  const chainIndex = intOrNaN(round.chainIndex)
  if (chainIndex !== undefined && !(Number.isInteger(chainIndex) && chainIndex >= 0)) {
    return { verdict: 'error', game: COUNTING_GAME, error: 'The chain index must be a whole number of 0 or more.' }
  }

  // The final count is a reveal INPUT (measured from the clip), not derived from
  // the seed — without it nothing can be recomputed, so this is an honest
  // "can't check", never a pass.
  const finalCount = intOrNaN(round.finalCount)
  if (finalCount === undefined) {
    return {
      verdict: 'error',
      game: COUNTING_GAME,
      error: 'The final count is required — it is measured from the clip, not derived from the seed.'
    }
  }
  if (!Number.isInteger(finalCount) || finalCount < 0) {
    return { verdict: 'error', game: COUNTING_GAME, error: 'The final count must be a whole number of 0 or more.' }
  }

  const gapRaw = intOrNaN(round.gap)
  const gap = gapRaw === undefined ? 3 : gapRaw
  if (!Number.isInteger(gap) || gap < 1) {
    return { verdict: 'error', game: COUNTING_GAME, error: 'The gap must be a whole number of 1 or more.' }
  }

  // ── the outcome weight table ───────────────────────────────────────────────
  let probabilities
  if (round.probabilities && typeof round.probabilities === 'object') {
    probabilities = round.probabilities
  } else {
    const names = parseList(round.outcomes)
    const ppm = parseList(round.weightsPpm)
    if (!names || !ppm) {
      return {
        verdict: 'error',
        game: COUNTING_GAME,
        error: 'Supply the round’s outcomes and weightsPpm (e.g. under,range,over,jackpot / 300000,400000,250000,50000).'
      }
    }
    if (names.length !== ppm.length) {
      return {
        verdict: 'error',
        game: COUNTING_GAME,
        error: `outcomes (${names.length}) and weightsPpm (${ppm.length}) must have the same number of entries.`
      }
    }
    const weights = ppm.map((x) => intOrNaN(x))
    if (weights.some((n) => !Number.isInteger(n) || n < 0)) {
      return { verdict: 'error', game: COUNTING_GAME, error: 'Every weight must be a whole number of parts-per-million.' }
    }
    const unknown = names.filter((n) => !OUTCOME_ORDER.includes(n))
    if (unknown.length) {
      return {
        verdict: 'error',
        game: COUNTING_GAME,
        error: `Unknown outcome(s) ${JSON.stringify(unknown)} — this verifier knows ${JSON.stringify(OUTCOME_ORDER)}.`
      }
    }
    if (new Set(names).size !== names.length) {
      return { verdict: 'error', game: COUNTING_GAME, error: 'The outcomes list contains a duplicate.' }
    }
    const sum = weights.reduce((a, b) => a + b, 0)
    if (sum !== WEIGHT_SCALE) {
      // A weight table that doesn't sum to 1e6 re-prices every bet in the round.
      // It is a published-value inconsistency, so it is an explicit FAILURE —
      // never renormalise it and never let it reach a green verdict.
      return {
        verdict: 'mismatch',
        game: COUNTING_GAME,
        error: `The published weights must sum to ${WEIGHT_SCALE} ppm (1.0); they sum to ${sum}.`,
        outcomes: names,
        publishedWeightsPpm: weights
      }
    }
    probabilities = {}
    names.forEach((n, i) => {
      probabilities[n] = weights[i] / WEIGHT_SCALE
    })
  }

  const proof = {
    schemeVersion: round.schemeVersion ?? 2,
    serverSeed: seed,
    nonce: round.nonce,
    beacon: round.beacon ?? '',
    chainRootHash: round.chainRootHash,
    chainIndex,
    observedCommitment: round.observedCommitment
  }
  const commit = await verifyCommitment(proof)

  let derived
  try {
    derived = await vehicleBoundaries(seed, probabilities, finalCount, {
      beacon: proof.beacon ?? '',
      gap
    })
  } catch (e) {
    // WEIGHT_SUM is a failed check on published values -> mismatch. Anything else
    // (unknown outcome, bad beacon, bad seed) is malformed input -> error.
    return {
      verdict: e.code === 'WEIGHT_SUM' ? 'mismatch' : 'error',
      game: COUNTING_GAME,
      error: e.message
    }
  }

  const publishedOutcome = isSupplied(round.outcome) ? trimLower(round.outcome) : undefined
  const publishedLower = intOrNaN(round.lowerBound)
  const publishedUpper = intOrNaN(round.upperBound)

  // Each published field is compared only if it was supplied. ALL THREE must be
  // supplied AND match for `resultMatches` to be true — a partial match is not a
  // reproduction, and any single supplied field that disagrees is a hard failure.
  const cmp = [
    [publishedOutcome, derived.outcome],
    [publishedLower, derived.lowerBound],
    [publishedUpper, derived.upperBound]
  ]
  let resultMatches
  if (cmp.some(([pub, got]) => pub !== undefined && pub !== got)) resultMatches = false
  else if (cmp.every(([pub]) => pub !== undefined)) resultMatches = true

  let verdict
  if (commit.commitmentVerified === false || resultMatches === false || commit.chainLinksToRoot === false) {
    verdict = 'mismatch'
  } else if (commit.commitmentVerified === true && resultMatches === true) {
    // GREEN requires BOTH: the pre-round commitment matches AND the published
    // outcome + both bounds were reproduced from the seed.
    verdict = 'verified'
  } else {
    verdict = 'inconclusive'
  }

  return {
    verdict,
    game: COUNTING_GAME,
    schemeVersion: proof.schemeVersion,
    finalCount,
    gap,
    outcome: derived.outcome,
    lowerBound: derived.lowerBound,
    upperBound: derived.upperBound,
    publishedOutcome,
    publishedLowerBound: publishedLower,
    publishedUpperBound: publishedUpper,
    outcomeMatches: publishedOutcome === undefined ? undefined : publishedOutcome === derived.outcome,
    boundsMatch:
      publishedLower === undefined || publishedUpper === undefined
        ? undefined
        : publishedLower === derived.lowerBound && publishedUpper === derived.upperBound,
    resultMatches,
    outcomes: derived.outcomes,
    weightsPpm: derived.weightsPpm,
    buckets: derived.buckets,
    target: derived.target,
    totalPpm: derived.totalPpm,
    outcomeHex13: derived.outcomeHex13,
    draws: derived.draws,
    beacon: proof.beacon ?? '',
    recomputedCommitment: commit.recomputedCommitment,
    observed: commit.observed,
    commitmentVerified: commit.commitmentVerified,
    chainLinksToRoot: commit.chainLinksToRoot,
    walked: commit.walked,
    root: commit.root,
    chainIndex: proof.chainIndex
  }
}

// ── marble races (marble_order) ──────────────────────────────────────────────
//
// High-level marble-round verifier. Input is a round's PUBLIC values:
//   { game: 'marble_order', serverSeed, observedCommitment, chainRootHash,
//     chainIndex, beacon = '',
//     order: 'blue,sky,red',                 <- the PUBLISHED finishing order (1st..Kth)
//     marbles: 'black,blue,green,…',         <- csv or array (canonical entrant order)
//     k: 3,                                  <- podium depth (1 for single-winner games)
//     weightsPpm: '471700,377400,…' }        <- csv or array, WEIGHTED single-winner only
//
// The finishing order is FULLY seed-derived (unlike counting's measured count):
// one "order" draw picks an index into the k-permutations (equal) or a weighted
// bucket (weighted, K==1). The result IS the finishing order shown to the player.
//
// Verdict rules mirror crash/counting exactly:
//   'verified'     — commitment matches AND the recomputed order EXACTLY equals
//                    the published order.
//   'mismatch'     — any check explicitly failed (incl. weights that don't sum).
//   'inconclusive' — consistent so far, but the commitment or the published order
//                    wasn't supplied, so nothing is certified. Never green.
//   'error'        — an input needed for the recomputation is missing/malformed.
export async function verifyMarbleRound(round) {
  const seed = String(round.serverSeed || '').trim().toLowerCase()
  if (!/^[0-9a-f]+$/i.test(seed) || seed.length % 2 !== 0) {
    return { verdict: 'error', game: MARBLE_GAME, error: 'The revealed seed must be an even-length hex string.' }
  }

  const chainIndex = intOrNaN(round.chainIndex)
  if (chainIndex !== undefined && !(Number.isInteger(chainIndex) && chainIndex >= 0)) {
    return { verdict: 'error', game: MARBLE_GAME, error: 'The chain index must be a whole number of 0 or more.' }
  }

  // The entrant list is required — a verifier cannot re-enumerate the
  // permutations (or the weighted buckets) without it.
  const marbles = parseList(round.marbles)
  if (!marbles || marbles.length === 0) {
    return { verdict: 'error', game: MARBLE_GAME, error: 'Supply the round’s marbles (the entrant names in canonical order).' }
  }
  if (new Set(marbles).size !== marbles.length) {
    return { verdict: 'error', game: MARBLE_GAME, error: 'The marbles list contains a duplicate.' }
  }
  const m = marbles.length

  const k = intOrNaN(round.k)
  if (k === undefined) {
    return { verdict: 'error', game: MARBLE_GAME, error: 'Supply k — the number of finishing places (1 for a single-winner game).' }
  }
  if (!Number.isInteger(k) || !(k >= 1 && k <= m)) {
    return { verdict: 'error', game: MARBLE_GAME, error: `k must be a whole number between 1 and ${m} (the entrant count).` }
  }

  // Weighted single-winner games publish an index-aligned ppm table; equal games omit it.
  let weightsPpm
  if (isSupplied(round.weightsPpm) || Array.isArray(round.weightsPpm)) {
    const raw = parseList(round.weightsPpm)
    if (!raw || raw.length === 0) {
      return { verdict: 'error', game: MARBLE_GAME, error: 'The weights (ppm) list is empty — omit it for an equal game, or supply one weight per marble.' }
    }
    const weights = raw.map((x) => intOrNaN(x))
    if (weights.some((n) => !Number.isInteger(n) || n < 0)) {
      return { verdict: 'error', game: MARBLE_GAME, error: 'Every weight must be a whole number of parts-per-million.' }
    }
    if (k !== 1) {
      return { verdict: 'error', game: MARBLE_GAME, error: 'Weighted marble rounds are single-winner only — supply weights only when k = 1.' }
    }
    if (weights.length !== m) {
      return { verdict: 'error', game: MARBLE_GAME, error: `weights (${weights.length}) must be index-aligned to the marbles (${m}).` }
    }
    const sum = weights.reduce((a, b) => a + b, 0)
    if (sum !== WEIGHT_SCALE) {
      // A weight table that doesn't sum to 1e6 re-prices every bet — an explicit
      // published-value FAILURE, never renormalised, never green (mirrors counting).
      return {
        verdict: 'mismatch',
        game: MARBLE_GAME,
        error: `The published weights must sum to ${WEIGHT_SCALE} ppm (1.0); they sum to ${sum}.`,
        marbles,
        publishedWeightsPpm: weights
      }
    }
    weightsPpm = weights
  }

  const proof = {
    schemeVersion: round.schemeVersion ?? 2,
    serverSeed: seed,
    nonce: round.nonce,
    beacon: round.beacon ?? '',
    chainRootHash: round.chainRootHash,
    chainIndex,
    observedCommitment: round.observedCommitment
  }
  const commit = await verifyCommitment(proof)

  let derived
  try {
    derived = await marbleOrder(seed, marbles, k, { beacon: proof.beacon ?? '', weightsPpm: weightsPpm ?? null })
  } catch (e) {
    // WEIGHT_SUM is a failed check on published values -> mismatch. Anything else
    // (bad k/M, empty marbles, bad beacon) is malformed input -> error.
    return { verdict: e.code === 'WEIGHT_SUM' ? 'mismatch' : 'error', game: MARBLE_GAME, error: e.message }
  }

  const publishedOrder = parseList(round.order)
  // The published order must EXACTLY equal the recomputed order (same length,
  // same names, same positions) — a partial or reordered list is not a match.
  let orderMatches
  if (publishedOrder !== undefined) {
    orderMatches =
      publishedOrder.length === derived.order.length &&
      publishedOrder.every((name, i) => name === derived.order[i])
  }

  // The reveal also publishes the raw draw and the chosen index — both fully
  // seed-derived. They are OPTIONAL cross-checks: a supplied value that disagrees
  // with the recomputation VETOES green (never fail open), but the finishing
  // ORDER is the result a green verdict certifies. For distinct marbles the index
  // and the order determine each other, so this can never contradict itself.
  const publishedIndex = intOrNaN(round.index)
  const indexMatches = publishedIndex === undefined ? undefined : publishedIndex === derived.index
  const publishedDraw = isSupplied(round.draw) ? trimLower(round.draw) : undefined
  const drawMatches = publishedDraw === undefined ? undefined : publishedDraw === derived.draw

  // GREEN needs the ORDER reproduced; a disagreeing index or draw is a hard fail.
  let resultMatches
  if (orderMatches === false || indexMatches === false || drawMatches === false) resultMatches = false
  else if (orderMatches === true) resultMatches = true

  let verdict
  if (commit.commitmentVerified === false || resultMatches === false || commit.chainLinksToRoot === false) {
    verdict = 'mismatch'
  } else if (commit.commitmentVerified === true && resultMatches === true) {
    // GREEN requires BOTH: the pre-round commitment matches AND the published
    // finishing order was reproduced from the seed.
    verdict = 'verified'
  } else {
    verdict = 'inconclusive'
  }

  return {
    verdict,
    game: MARBLE_GAME,
    schemeVersion: proof.schemeVersion,
    marbles: derived.marbles,
    k: derived.k,
    weighted: derived.weighted,
    weightsPpm: derived.weightsPpm,
    order: derived.order,
    publishedOrder,
    orderMatches,
    resultMatches,
    publishedIndex,
    indexMatches,
    publishedDraw,
    drawMatches,
    draw: derived.draw,
    index: derived.index,
    permCount: derived.permCount,
    target: derived.target,
    totalPpm: derived.totalPpm,
    buckets: derived.buckets,
    beacon: proof.beacon ?? '',
    recomputedCommitment: commit.recomputedCommitment,
    observed: commit.observed,
    commitmentVerified: commit.commitmentVerified,
    chainLinksToRoot: commit.chainLinksToRoot,
    walked: commit.walked,
    root: commit.root,
    chainIndex: proof.chainIndex
  }
}

// A csv string or an array -> a trimmed, lowercased, blank-free array.
// Returns undefined when nothing was supplied.
function parseList(v) {
  if (Array.isArray(v)) return v.map((x) => trimLower(x)).filter((s) => s !== '')
  if (!isSupplied(v)) return undefined
  return String(v)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '')
}

// Dispatcher on the `game` discriminator. ABSENT (or anything unrecognised)
// means crash — the original single-game contract, which must never break.
export async function verifyRound(round) {
  const game = trimLower(round?.game ?? '')
  if (game === COUNTING_GAME) return verifyCountingRound(round)
  if (game === MARBLE_GAME) return verifyMarbleRound(round)
  return verifyCrashRound(round)
}
