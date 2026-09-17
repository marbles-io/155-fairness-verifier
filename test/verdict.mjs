// Verdict + input-handling edge cases — locks the fixes for the issues the
// adversarial review found (false-green on no-multiplier, whitespace/empty/NaN
// coercion, non-hex fail-open). Run against src/verify.js AND (via the shared
// CASES / COUNTING_CASES / DISPATCH_CASES exports) against verify.html's inlined
// copy in check-inline.mjs — the two must never diverge.
//
//   node test/verdict.mjs

import { verifyCrashRound, verifyCountingRound, verifyMarbleRound, verifyBirdieRound, verifyRound } from '../src/verify.js'

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

// ── birdie (game=birdie) ─────────────────────────────────────────────────────
// The vector seed (link index 1 of the fairness chain, so chainIndex 1 walks to
// the root) with every value the reveal publishes, each produced by the game
// engine itself. The card the seed draws is e02, make rate 500000, so the board
// here is the 500000 board — a coherent round.
const BIRDIE_CATALOGUE = [
  { entry_id: 'e01', golfer_id: 'g_tom', location_id: 'l_bangsaen', make_rate_ppm: 300000, weight_ppm: 333334 },
  { entry_id: 'e02', golfer_id: 'g_tom', location_id: 'l_hua_hin', make_rate_ppm: 500000, weight_ppm: 333333 },
  { entry_id: 'e03', golfer_id: 'g_mai', location_id: 'l_bangsaen', make_rate_ppm: 150000, weight_ppm: 333333 }
]
const BIRDIE_GOLD = {
  game: 'birdie',
  serverSeed: '56c858f2b088359debfc994ef774b37ecf96871cceb2f132805e7290047d907d',
  observedCommitment: '9968162c0cfdb6f10d33b847644c3717ae4bc105b186af847c8fc40f8564f6bb',
  chainRootHash: '9968162c0cfdb6f10d33b847644c3717ae4bc105b186af847c8fc40f8564f6bb',
  chainIndex: 1,
  marbles: 'm-HHH,m-HHM,m-HMH,m-MHH,m-HMM,m-MHM,m-MMH,m-MMM',
  makeRatePpm: 500000,
  weightsPpm: '125000,125000,125000,125000,125000,125000,125000,125000',
  paytableHash: '468afe9bc9bee5d15a55c2dc32eefeeddf92d157c86613a59ccd6d8b26bb9bcc',
  order: 'm-MMM',
  index: 7,
  draw: 'e3683ddb85d3f',
  cardDraw: '758f351ff7aa2',
  cardIndex: 1,
  catalogueHash: '7f1c0b9d89b083d9cf1c06d73541e79ed6d1aec10f35c7192252e92cfe5f86f3',
  catalogueSize: 3,
  catalogue: BIRDIE_CATALOGUE,
  roundType: 'frost',
  roundTypeDraw: 'bee16e4749787',
  roundTypesPpm: 'none:715000,frost:190000,fire:95000'
}
const bclone = (o) => ({ ...BIRDIE_GOLD, ...o })

export const BIRDIE_CASES = [
  ['birdie full round → verified', BIRDIE_GOLD, 'verified'],
  ['birdie: the deep link (no catalogue pasted) → verified, card provenance simply unchecked', bclone({ catalogue: undefined }), 'verified'],
  ['birdie: catalogue as a JSON string → verified', bclone({ catalogue: JSON.stringify(BIRDIE_CATALOGUE) }), 'verified'],
  ['birdie: catalogue as the registry row ({entries}) with an ineligible extra → verified', bclone({ catalogue: { entries: [...BIRDIE_CATALOGUE, { entry_id: 'e99', golfer_id: 'g_x', location_id: 'l_x', make_rate_ppm: 400000, weight_ppm: 0, eligible: false }] } }), 'verified'],
  ['birdie: catalogue supplied in any order → verified (sorted by entry_id before the draw)', bclone({ catalogue: [...BIRDIE_CATALOGUE].reverse() }), 'verified'],
  ['birdie: round-type weights as three ints in none,frost,fire order → verified', bclone({ roundTypesPpm: '715000,190000,95000' }), 'verified'],
  ['birdie: round-type weights as an object → verified', bclone({ roundTypesPpm: { none: 715000, frost: 190000, fire: 95000 } }), 'verified'],
  ['birdie: arrays instead of csv → verified', bclone({ marbles: BIRDIE_GOLD.marbles.split(','), order: ['m-MMM'], weightsPpm: [125000, 125000, 125000, 125000, 125000, 125000, 125000, 125000] }), 'verified'],
  ['birdie: UPPERCASE + padded hashes → verified', bclone({ paytableHash: '  ' + BIRDIE_GOLD.paytableHash.toUpperCase() + '  ', cardDraw: BIRDIE_GOLD.cardDraw.toUpperCase(), roundType: ' FROST ' }), 'verified'],
  ['birdie: a plain (none) round with no round type published → verified', bclone({ roundType: undefined, roundTypeDraw: undefined, roundTypesPpm: undefined }), 'verified'],
  ['birdie: a round with no side market (round_type none, round_types_ppm {}) → verified, nothing to draw against', bclone({ roundType: 'none', roundTypeDraw: undefined, roundTypesPpm: {} }), 'verified'],
  ['birdie: round_type none published with no weights → verified (nothing was paid on it)', bclone({ roundType: 'none', roundTypesPpm: undefined }), 'verified'],
  ['birdie: round_type none published WITH weights that draw frost → mismatch', bclone({ roundType: 'none' }), 'mismatch'],
  ['birdie: no optional cross-checks at all → verified on commitment + pattern', bclone({ weightsPpm: undefined, paytableHash: undefined, index: undefined, draw: undefined, cardDraw: undefined, cardIndex: undefined, catalogueHash: undefined, catalogueSize: undefined, catalogue: undefined, roundType: undefined, roundTypeDraw: undefined, roundTypesPpm: undefined }), 'verified'],
  ['birdie: a supplied non-empty beacon is IGNORED (Birdie has none) → verified', bclone({ beacon: 'deadbeef' }), 'verified'],
  // — explicit failures —
  ['birdie wrong pattern → mismatch', bclone({ order: 'm-HHH' }), 'mismatch'],
  ['birdie wrong index (order still correct) → mismatch', bclone({ index: 0 }), 'mismatch'],
  ['birdie wrong order draw → mismatch', bclone({ draw: '0000000000000' }), 'mismatch'],
  ['birdie tampered make rate → mismatch (weights, paytable AND card make rate all disagree)', bclone({ makeRatePpm: 300000 }), 'mismatch'],
  ['birdie tampered make rate, nothing else published → still mismatch via the paytable hash', bclone({ makeRatePpm: 300000, weightsPpm: undefined, catalogue: undefined, cardIndex: undefined }), 'mismatch'],
  ['birdie published weights that disagree with the make rate → mismatch', bclone({ weightsPpm: '27000,63000,63000,63000,147000,147000,147000,343000' }), 'mismatch'],
  ['birdie tampered paytable hash → mismatch', bclone({ paytableHash: 'deadbeef'.repeat(8) }), 'mismatch'],
  ['birdie wrong round type → mismatch', bclone({ roundType: 'fire' }), 'mismatch'],
  ['birdie wrong round-type draw → mismatch', bclone({ roundTypeDraw: '0000000000000' }), 'mismatch'],
  ['birdie round-type weights that change the bucket → mismatch', bclone({ roundTypesPpm: 'none:100000,frost:100000,fire:800000' }), 'mismatch'],
  ['birdie wrong card draw → mismatch', bclone({ cardDraw: '0000000000000' }), 'mismatch'],
  ['birdie wrong card index (catalogue supplied) → mismatch', bclone({ cardIndex: 0 }), 'mismatch'],
  ['birdie tampered catalogue (a weight moved) → mismatch via the catalogue hash', bclone({ catalogue: [{ ...BIRDIE_CATALOGUE[0], weight_ppm: 333333 }, { ...BIRDIE_CATALOGUE[1], weight_ppm: 333334 }, BIRDIE_CATALOGUE[2]] }), 'mismatch'],
  ['birdie catalogue whose drawn card has a different make rate → mismatch', bclone({ catalogue: [BIRDIE_CATALOGUE[0], { ...BIRDIE_CATALOGUE[1], make_rate_ppm: 400000 }, BIRDIE_CATALOGUE[2]], catalogueHash: undefined }), 'mismatch'],
  ['birdie catalogue size that disagrees → mismatch', bclone({ catalogueSize: 4 }), 'mismatch'],
  ['birdie tampered commitment → mismatch', bclone({ observedCommitment: 'deadbeef'.repeat(8) }), 'mismatch'],
  ['birdie tampered chain root → mismatch', bclone({ chainRootHash: 'deadbeef'.repeat(8) }), 'mismatch'],
  ['birdie zero-sum round-type weights → mismatch (published values fail, never renormalised)', bclone({ roundTypesPpm: 'none:0,frost:0,fire:0' }), 'mismatch'],
  // — honest "can't check" (never green, never a false accusation) —
  ['birdie no commitment → inconclusive', bclone({ observedCommitment: undefined }), 'inconclusive'],
  ['birdie no published pattern → inconclusive (result never cross-checked)', bclone({ order: undefined, index: undefined, draw: undefined }), 'inconclusive'],
  ['birdie round type published but no weights to recompute it → inconclusive, NOT green', bclone({ roundTypesPpm: undefined }), 'inconclusive'],
  ['birdie missing marbles → error', bclone({ marbles: undefined }), 'error'],
  ['birdie seven marbles → error', bclone({ marbles: 'm-HHH,m-HHM,m-HMH,m-MHH,m-HMM,m-MHM,m-MMH' }), 'error'],
  ['birdie duplicate marble → error', bclone({ marbles: 'm-HHH,m-HHH,m-HMH,m-MHH,m-HMM,m-MHM,m-MMH,m-MMM' }), 'error'],
  ['birdie missing make rate → error', bclone({ makeRatePpm: undefined }), 'error'],
  ['birdie fractional make rate → error', bclone({ makeRatePpm: '500000.5' }), 'error'],
  ['birdie negative make rate → error', bclone({ makeRatePpm: -1 }), 'error'],
  ['birdie weights length mismatch → error', bclone({ weightsPpm: '125000,125000' }), 'error'],
  ['birdie non-integer weight → error', bclone({ weightsPpm: '125000,125000,125000,125000,125000,125000,125000,125000.5' }), 'error'],
  ['birdie unknown round type name → error', bclone({ roundType: 'lava' }), 'error'],
  ['birdie unknown round-type weight name → error', bclone({ roundTypesPpm: 'none:715000,frost:190000,lava:95000' }), 'error'],
  ['birdie two bare round-type ints → error (three, in order, or name:ppm)', bclone({ roundTypesPpm: '715000,285000' }), 'error'],
  ['birdie a name:ppm item with an extra segment → error, never guessed', bclone({ roundTypesPpm: 'none:715000:junk,frost:190000,fire:95000' }), 'error'],
  ['birdie a round type listed twice → error, never last-wins', bclone({ roundTypesPpm: 'none:1,none:715000,frost:190000,fire:95000' }), 'error'],
  ['birdie catalogue that is not JSON → error', bclone({ catalogue: '{not json' }), 'error'],
  ['birdie catalogue entry missing weight_ppm → error', bclone({ catalogue: [{ entry_id: 'e01', golfer_id: 'g', location_id: 'l', make_rate_ppm: 300000 }] }), 'error'],
  ['birdie catalogue with a duplicate entry_id → error', bclone({ catalogue: [BIRDIE_CATALOGUE[0], BIRDIE_CATALOGUE[0]] }), 'error'],
  ['birdie catalogue with only ineligible entries → error', bclone({ catalogue: [{ ...BIRDIE_CATALOGUE[0], eligible: false }] }), 'error'],
  ['birdie fractional card index → error', bclone({ cardIndex: '1.5' }), 'error'],
  ['birdie non-hex seed → error', bclone({ serverSeed: 'zz'.repeat(32) }), 'error'],
  ['birdie odd-length seed → error', bclone({ serverSeed: 'abc' }), 'error'],
  ['birdie garbage chainIndex → error', bclone({ chainIndex: 'one' }), 'error'],
  ['birdie blank chainIndex → verified (chain not checked, no false-red)', bclone({ chainIndex: '' }), 'verified'],
  ['birdie whitespace-only chainIndex → verified (NOT a 0-step walk)', bclone({ chainIndex: '  ' }), 'verified']
]
export { BIRDIE_GOLD }

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
  ['dispatch: marble round without game= → not verified by the crash path', { ...MARBLE_GOLD, game: undefined }, 'inconclusive'],
  ['dispatch: game=birdie → birdie verifier', BIRDIE_GOLD, 'verified'],
  ['dispatch: game="  BIRDIE  " → birdie verifier', bclone({ game: '  BIRDIE  ' }), 'verified'],
  // a birdie round handed to the crash path must NOT go green by accident
  ['dispatch: birdie round without game= → not verified by the crash path', { ...BIRDIE_GOLD, game: undefined }, 'inconclusive']
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
  for (const [name, round, want] of BIRDIE_CASES) await one(verifyBirdieRound, name, round, want)
  for (const [name, round, want] of DISPATCH_CASES) await one(verifyRound, name, round, want)
  const total = CASES.length + COUNTING_CASES.length + MARBLE_CASES.length + BIRDIE_CASES.length + DISPATCH_CASES.length
  console.log(fail ? `\nverdict cases: ${fail} FAILED` : `✓ verdict edge cases (${total}) all correct — crash ${CASES.length}, counting ${COUNTING_CASES.length}, marble ${MARBLE_CASES.length}, birdie ${BIRDIE_CASES.length}, dispatch ${DISPATCH_CASES.length}`)
  return fail
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) ? 1 : 0)
