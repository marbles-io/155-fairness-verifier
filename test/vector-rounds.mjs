// Every pre-1.1.0 golden vector as a ROUND a verifier is handed: the commitment is
// sha256(seed) and the published result is the vector's. Shared by test/run.mjs
// (src/) and test/check-inline.mjs (verify.html's copy), so both prove the same
// promise: every existing vector still verifies — as scheme 2 exactly as before
// (the scheme absent or 2), and as scheme 3 too, because no existing draw is ever
// rejected (RNG 1.1.0 keeps every accepted index).

import { createHash } from 'node:crypto'

const sha256Ascii = (s) => createHash('sha256').update(s, 'ascii').digest('hex')

// The scheme values a round can carry today, plus the new one.
export const SCHEMES = [['scheme absent', undefined], ['scheme 2', 2], ['scheme 3', 3]]

export function vectorRounds(V) {
  const rounds = []
  for (const c of V.crash) {
    rounds.push([`crash[r=${c.r}]`, {
      serverSeed: c.server_seed, observedCommitment: sha256Ascii(c.server_seed), beacon: c.beacon,
      houseEdge: c.house_edge, multiplier: c.crash_multiplier
    }])
  }
  for (const v of V.vehicle_boundaries) {
    rounds.push([`vehicle[${v.note}]`, {
      game: 'vehicle_boundaries', serverSeed: v.server_seed, observedCommitment: sha256Ascii(v.server_seed),
      beacon: v.beacon, finalCount: v.final_count, gap: v.gap,
      outcome: v.outcome, lowerBound: v.lower_bound, upperBound: v.upper_bound,
      outcomes: v.outcomes, weightsPpm: v.weights_ppm
    }])
  }
  for (const v of V.marble_order) {
    const round = {
      game: 'marble_order', serverSeed: v.server_seed, observedCommitment: sha256Ascii(v.server_seed),
      beacon: v.beacon, marbles: v.marbles, k: v.k, order: v.order, index: v.index, draw: v.draw
    }
    if (v.weights_ppm !== undefined) round.weightsPpm = v.weights_ppm
    rounds.push([`marble[${v.note}]`, round])
  }
  return rounds
}

export function withScheme(round, scheme) {
  const r = { ...round }
  if (scheme === undefined) delete r.schemeVersion
  else r.schemeVersion = scheme
  return r
}
