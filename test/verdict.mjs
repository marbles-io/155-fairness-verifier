// Verdict + input-handling edge cases — locks the fixes for the issues the
// adversarial review found (false-green on no-multiplier, whitespace/empty/NaN
// coercion, non-hex fail-open). Run against src/verify.js AND (via the shared
// CASES / COUNTING_CASES / DISPATCH_CASES exports) against verify.html's inlined
// copy in check-inline.mjs — the two must never diverge.
//
//   node test/verdict.mjs

import { verifyCrashRound, verifyCountingRound, verifyMarbleRound, verifyRound } from '../src/verify.js'

// A fully-green example round.
const GOLD = {
  serverSeed: '6f7081467a4fe6be90f22066336379ea2f20558037e84a030b4626cbafb1025a',
  observedCommitment: 'd2d41bed3cc891015cb989253a8b009ee85178003677b6099c910ca9937e6879',
  chainRootHash: 'f22f0e6ace208f306e6f3d186bc18a8632eb64579a19d6c04e9e46ff25760984',
  chainIndex: 4,
  houseEdge: 0.06,
  multiplier: 5.16
}
const clone = (o) => ({ ...GOLD, ...o })

// [name, round, expected verdict]. Exported so check-inline.mjs runs the SAME
// cases against verify.html's inlined verifier (they must never diverge).
export const CASES = [
  ['full round → verified', GOLD, 'verified'],
  ['no result multiplier → inconclusive (NOT verified: result never cross-checked)', clone({ multiplier: undefined }), 'inconclusive'],
  ['no commitment → inconclusive (can’t prove pre-commitment)', clone({ observedCommitment: undefined }), 'inconclusive'],
  ['tampered multiplier → mismatch', clone({ multiplier: 9.99 }), 'mismatch'],
  ['wrong commitment → mismatch', clone({ observedCommitment: 'deadbeef'.repeat(8) }), 'mismatch'],
  ['whitespace-padded commitment → still verified', clone({ observedCommitment: '  ' + GOLD.observedCommitment + '  ' }), 'verified'],
  ['UPPERCASE commitment → still verified', clone({ observedCommitment: GOLD.observedCommitment.toUpperCase() }), 'verified'],
  ['blank chainIndex → verified (chain simply not checked, no false-red)', clone({ chainIndex: '' }), 'verified'],
  // ↓ the three whitespace-only cases. src treated "  " as absent; verify.html's
  // inlined copy tested `!= null` / `!== ''` and so coerced it (Number('  ') === 0
  // → a 0-step walk → seed vs root → false → a FALSE RED on an honest round; and
  // '  '.trim() === '' → commitment compared against the empty string). A blank
  // is never a value: all three must read as "not supplied".
  ['whitespace-only chainIndex → verified (NOT a 0-step chain walk)', clone({ chainIndex: '  ' }), 'verified'],
  ['whitespace-only chainRootHash → verified (root simply not supplied)', clone({ chainRootHash: '  ' }), 'verified'],
  ['whitespace-only commitment → inconclusive (not a comparison against "")', clone({ observedCommitment: '  ' }), 'inconclusive'],
  ['garbage chainIndex → error (never a silent skip to green)', clone({ chainIndex: 'seventy-five' }), 'error'],
  ['fractional chainIndex → error', clone({ chainIndex: '4.5' }), 'error'],
  ['negative chainIndex → error', clone({ chainIndex: -4 }), 'error'],
  ['non-hex seed → error', clone({ serverSeed: 'zz'.repeat(32) }), 'error'],
  ['odd-length seed → error', clone({ serverSeed: 'abc' }), 'error']
]

// ── counting games (game=vehicle_boundaries) ─────────────────────────────────
// A 4-way round with a matching commitment and a 4-link chain walked to its root.
const COUNT_GOLD = {
  game: 'vehicle_boundaries',
  serverSeed: 'b157310dd16e5f3d7d68b28d51c3836d4b79f548399ad6ee738d27008ea26ccf',
  observedCommitment: 'b73b9ac5c4a3dc221efe4c009727a2840e5234b49c36cc7aa01b5d621f1ada99',
  chainRootHash: '561317e8f0de48a4326ec322dcf555db8bc986505dac052f6cc797ff7fa76d4e',
  chainIndex: 4,
  beacon: '',
  finalCount: 14,
  gap: 3,
  outcome: 'under',
  lowerBound: 16,
  upperBound: 19,
  outcomes: 'under,range,over,jackpot',
  weightsPpm: '300000,400000,250000,50000'
}
const cclone = (o) => ({ ...COUNT_GOLD, ...o })

export const COUNTING_CASES = [
  ['counting full round → verified', COUNT_GOLD, 'verified'],
  ['counting with arrays instead of csv → verified', cclone({ outcomes: ['under', 'range', 'over', 'jackpot'], weightsPpm: [300000, 400000, 250000, 50000] }), 'verified'],
  ['counting outcomes listed out of canonical order → verified (re-canonicalised)', cclone({ outcomes: 'jackpot,over,under,range', weightsPpm: '50000,250000,300000,400000' }), 'verified'],
  ['counting 3-way round (no jackpot, range INCLUSIVE) → verified', {
    game: 'vehicle_boundaries',
    serverSeed: '7fe6e446435a03cefd838f025509e9d086e79c3c710028be1c48d3e62c6b16e9',
    observedCommitment: 'b82e9b94fe94df51009d30d74deefbddea10aca2e18db4f2ab4ed1ae36c9d115',
    finalCount: 14, gap: 3, outcome: 'range', lowerBound: 11, upperBound: 14,
    outcomes: 'under,range,over', weightsPpm: '300000,400000,300000'
  }, 'verified'],
  ['counting jackpot round → verified', {
    game: 'vehicle_boundaries',
    serverSeed: '92f5428bb5199b134c89116dee5d8b1ef343436c8a8ef103a681349f7f56dbfd',
    observedCommitment: '40cb323531c070e2d59d61a68cdd4aa47c07b0f9bbdf1b3efbc638f07d59111c',
    chainRootHash: '0db8fea3e4ea69763bb995340fd76303dddf30fd6cfa40c43c2c9ce872102a21',
    chainIndex: 2,
    finalCount: 14, gap: 3, outcome: 'jackpot', lowerBound: 14, upperBound: 17,
    outcomes: 'under,range,over,jackpot', weightsPpm: '300000,400000,250000,50000'
  }, 'verified'],
  ['counting UPPERCASE outcome + padded commitment → verified', cclone({ outcome: 'UNDER', observedCommitment: '  ' + COUNT_GOLD.observedCommitment.toUpperCase() + '  ' }), 'verified'],
  // — explicit failures —
  ['counting wrong lowerBound → mismatch', cclone({ lowerBound: 15 }), 'mismatch'],
  ['counting wrong upperBound → mismatch', cclone({ upperBound: 20 }), 'mismatch'],
  ['counting wrong outcome → mismatch', cclone({ outcome: 'over' }), 'mismatch'],
  ['counting tampered commitment → mismatch', cclone({ observedCommitment: 'deadbeef'.repeat(8) }), 'mismatch'],
  ['counting tampered chain root → mismatch', cclone({ chainRootHash: 'deadbeef'.repeat(8) }), 'mismatch'],
  ['counting tampered finalCount → mismatch (bounds move with it)', cclone({ finalCount: 15 }), 'mismatch'],
  ['counting tampered gap → mismatch', cclone({ gap: 4 }), 'mismatch'],
  ['counting weights that do not sum to 1e6 → mismatch (NEVER renormalised)', cclone({ weightsPpm: '300000,400000,250000,40000' }), 'mismatch'],
  ['counting weights over 1e6 → mismatch', cclone({ weightsPpm: '300000,400000,250000,60000' }), 'mismatch'],
  ['counting probabilities object that does not sum → mismatch', cclone({ outcomes: undefined, weightsPpm: undefined, probabilities: { under: 0.3, range: 0.4, over: 0.25, jackpot: 0.04 } }), 'mismatch'],
  // — honest "can't check" (never green, never a false accusation) —
  ['counting missing finalCount → error, never green', cclone({ finalCount: undefined }), 'error'],
  ['counting blank finalCount → error, never green', cclone({ finalCount: '  ' }), 'error'],
  ['counting non-integer finalCount → error', cclone({ finalCount: '14.5' }), 'error'],
  ['counting missing weights → error', cclone({ weightsPpm: undefined }), 'error'],
  ['counting outcomes/weights length mismatch → error', cclone({ weightsPpm: '300000,400000,300000' }), 'error'],
  ['counting unknown outcome name → error', cclone({ outcomes: 'under,range,over,sideways' }), 'error'],
  ['counting non-hex seed → error', cclone({ serverSeed: 'zz'.repeat(32) }), 'error'],
  ['counting garbage chainIndex → error', cclone({ chainIndex: 'four' }), 'error'],
  ['counting no commitment → inconclusive (can’t prove pre-commitment)', cclone({ observedCommitment: undefined }), 'inconclusive'],
  ['counting no published bounds → inconclusive (result never cross-checked)', cclone({ lowerBound: undefined, upperBound: undefined }), 'inconclusive'],
  ['counting outcome only, no bounds → inconclusive (partial is not a reproduction)', cclone({ lowerBound: undefined, upperBound: undefined, outcome: 'under' }), 'inconclusive'],
  ['counting blank chainIndex → verified (chain not checked, no false-red)', cclone({ chainIndex: '' }), 'verified'],
  ['counting whitespace-only chainIndex → verified (NOT a 0-step walk)', cclone({ chainIndex: '  ' }), 'verified'],
  ['counting default gap=3 when gap omitted → verified', cclone({ gap: undefined }), 'verified']
]

// ── marble races (game=marble_order) ─────────────────────────────────────────
// An equal podium round (8-marble, K=3) with a matching commitment and a 3-link
// chain walked to its root.
const MARBLE_GOLD = {
  game: 'marble_order',
  serverSeed: '420ccb7d86addd5701549ba9b3ad7df12a603b32ab5aa31c2b5b6eda87ff4105',
  observedCommitment: 'afa0a6c588760ada8ff4e0834cb0c0625840f0714a0c2837bd4f4b91deee963c',
  chainRootHash: '4bc6089fee3d1a491babd43aa87c0440adc3cb3b932c63522126901c16afbe42',
  chainIndex: 3,
  beacon: '',
  marbles: 'black,blue,green,orange,red,sky,white,yellow',
  k: 3,
  order: 'blue,sky,red',
  index: 69,
  draw: '34fbc80db5fce'
}
const mclone = (o) => ({ ...MARBLE_GOLD, ...o })

// A weighted single-winner round (5-way).
const MARBLE_WEIGHTED = {
  game: 'marble_order',
  serverSeed: 'bb805313a7ad6270c487a053fb6c90071e760f3841e4e85c78affa851cee1686',
  observedCommitment: 'fec213f3f8efd126590a747b0ebf9c24e3e05112e08f996ddda2ca1d57633f0a',
  chainRootHash: 'eb755915cd0036073e450e1f5ae061db4c2052abdb3a50fe3840ee259aaf3802',
  chainIndex: 2,
  beacon: '',
  marbles: 'white,orange,green,blue,pink',
  k: 1,
  weightsPpm: '471700,377400,94300,47200,9400',
  order: 'white',
  index: 0,
  draw: '198d357e41f88'
}

export const MARBLE_CASES = [
  ['marble full podium round → verified', MARBLE_GOLD, 'verified'],
  ['marble with arrays instead of csv → verified', mclone({ marbles: ['black', 'blue', 'green', 'orange', 'red', 'sky', 'white', 'yellow'], order: ['blue', 'sky', 'red'] }), 'verified'],
  ['marble UPPERCASE order + padded commitment → verified', mclone({ order: 'BLUE,SKY,RED', observedCommitment: '  ' + MARBLE_GOLD.observedCommitment.toUpperCase() + '  ' }), 'verified'],
  ['marble weighted single-winner round → verified', MARBLE_WEIGHTED, 'verified'],
  ['marble non-empty beacon round → verified (beacon reaches the order draw)', {
    game: 'marble_order',
    serverSeed: 'ccbb1df93b4352dfe16104d57df8817420ee2b0333a004aa5d7d90e655b43cb7',
    observedCommitment: '29200586e575d07652715916d0c839fe633bc9880da2e0f182d93d541d745ecd',
    beacon: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    marbles: 'black,blue,green,orange,red,sky,white,yellow', k: 3,
    order: 'black,red,white'
  }, 'verified'],
  ['marble single-entrant forced win → verified', {
    game: 'marble_order',
    serverSeed: '1aaea725e0443858d7307709c95eb5ebabc03cf09e6ae4ed94297487c3215344',
    observedCommitment: 'c9af4ac64f5ec5ca5fc0f34fae1b611e6bb81c7f4450b4498f7b7f78b6ab7712',
    marbles: 'solo', k: 1, order: 'solo'
  }, 'verified'],
  // — explicit failures —
  ['marble wrong order → mismatch', mclone({ order: 'sky,blue,red' }), 'mismatch'],
  ['marble wrong index (order still supplied correct) → mismatch', mclone({ index: 70 }), 'mismatch'],
  ['marble wrong index, no order supplied → mismatch', mclone({ order: undefined, index: 70 }), 'mismatch'],
  ['marble wrong draw → mismatch', mclone({ draw: '0000000000000' }), 'mismatch'],
  ['marble tampered commitment → mismatch', mclone({ observedCommitment: 'deadbeef'.repeat(8) }), 'mismatch'],
  ['marble tampered chain root → mismatch', mclone({ chainRootHash: 'deadbeef'.repeat(8) }), 'mismatch'],
  ['marble weighted weights that do not sum to 1e6 → mismatch (NEVER renormalised)', { ...MARBLE_WEIGHTED, weightsPpm: '471700,377400,94300,47200,9500' }, 'mismatch'],
  // — honest "can't check" (never green, never a false accusation) —
  ['marble missing marbles → error, never green', mclone({ marbles: undefined }), 'error'],
  ['marble missing k → error', mclone({ k: undefined }), 'error'],
  ['marble k>M → error', mclone({ k: 9 }), 'error'],
  ['marble k=0 → error', mclone({ k: 0 }), 'error'],
  ['marble fractional k → error', mclone({ k: '2.5' }), 'error'],
  ['marble duplicate marble → error', mclone({ marbles: 'black,black,green,orange,red,sky,white,yellow' }), 'error'],
  ['marble weighted with k!=1 → error', mclone({ weightsPpm: '500000,500000', marbles: 'black,blue', order: 'blue' }), 'error'],
  ['marble weights length mismatch → error', { ...MARBLE_WEIGHTED, weightsPpm: '471700,377400,94300,47200' }, 'error'],
  ['marble non-integer weight → error', { ...MARBLE_WEIGHTED, weightsPpm: '471700,377400,94300,47200,9400.5' }, 'error'],
  ['marble non-hex seed → error', mclone({ serverSeed: 'zz'.repeat(32) }), 'error'],
  ['marble odd-length seed → error', mclone({ serverSeed: 'abc' }), 'error'],
  ['marble garbage chainIndex → error', mclone({ chainIndex: 'three' }), 'error'],
  ['marble no commitment → inconclusive (can’t prove pre-commitment)', mclone({ observedCommitment: undefined }), 'inconclusive'],
  ['marble no published order → inconclusive (result never cross-checked)', mclone({ order: undefined, index: undefined, draw: undefined }), 'inconclusive'],
  ['marble blank chainIndex → verified (chain not checked, no false-red)', mclone({ chainIndex: '' }), 'verified'],
  ['marble whitespace-only chainIndex → verified (NOT a 0-step walk)', mclone({ chainIndex: '  ' }), 'verified']
]

// The dispatcher: `game` absent (or anything unrecognised) MUST stay crash.
export const DISPATCH_CASES = [
  ['dispatch: no game → crash verifier', GOLD, 'verified'],
  ['dispatch: game=vehicle_boundaries → counting verifier', COUNT_GOLD, 'verified'],
  ['dispatch: game="  VEHICLE_BOUNDARIES  " → counting verifier', cclone({ game: '  VEHICLE_BOUNDARIES  ' }), 'verified'],
  ['dispatch: game=marble_order → marble verifier', MARBLE_GOLD, 'verified'],
  ['dispatch: game="  MARBLE_ORDER  " → marble verifier', mclone({ game: '  MARBLE_ORDER  ' }), 'verified'],
  ['dispatch: game=crash → crash verifier', clone({ game: 'crash' }), 'verified'],
  ['dispatch: unknown game → crash verifier (back-compat)', clone({ game: 'marble_race' }), 'verified'],
  // a counting round handed to the crash path must NOT go green by accident
  ['dispatch: counting round without game= → not verified by the crash path', { ...COUNT_GOLD, game: undefined }, 'inconclusive'],
  // a marble round handed to the crash path must NOT go green by accident
  ['dispatch: marble round without game= → not verified by the crash path', { ...MARBLE_GOLD, game: undefined }, 'inconclusive']
]

async function run() {
  let fail = 0
  const one = async (fn, name, round, want) => {
    const got = (await fn(round)).verdict
    if (got !== want) { fail++; console.log(`  ✗ ${name}\n      got ${got}, want ${want}`) }
  }
  for (const [name, round, want] of CASES) await one(verifyCrashRound, name, round, want)
  for (const [name, round, want] of COUNTING_CASES) await one(verifyCountingRound, name, round, want)
  for (const [name, round, want] of MARBLE_CASES) await one(verifyMarbleRound, name, round, want)
  for (const [name, round, want] of DISPATCH_CASES) await one(verifyRound, name, round, want)
  const total = CASES.length + COUNTING_CASES.length + MARBLE_CASES.length + DISPATCH_CASES.length
  console.log(fail ? `\nverdict cases: ${fail} FAILED` : `✓ verdict edge cases (${total}) all correct — crash ${CASES.length}, counting ${COUNTING_CASES.length}, marble ${MARBLE_CASES.length}, dispatch ${DISPATCH_CASES.length}`)
  return fail
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) ? 1 : 0)
