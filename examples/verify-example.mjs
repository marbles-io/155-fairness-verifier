// Verify a round JSON from the command line:
//   node examples/verify-example.mjs                       # the bundled verified round
//   node examples/verify-example.mjs examples/crash-mismatch.json
//   node examples/verify-example.mjs examples/counting-verified.json
//   node examples/verify-example.mjs examples/marble-verified.json
//   node examples/verify-example.mjs examples/birdie-verified.json
//   node examples/verify-example.mjs path/to/your-round.json
//
// The game is taken from the round's `game` field — absent means crash.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { verifyRound, COUNTING_GAME, MARBLE_GAME, BIRDIE_GAME } from '../src/verify.js'

const here = dirname(fileURLToPath(import.meta.url))
const file = process.argv[2] || join(here, 'crash-verified.json')
const round = JSON.parse(readFileSync(file, 'utf8'))
const r = await verifyRound(round)

const line = (k, v) => console.log('  ' + k.padEnd(20) + v)
const yesNo = (v) => (v === undefined ? 'not supplied' : v ? 'yes ✓' : 'NO ✕')
console.log('\n' + file)
console.log('\nVERDICT: ' + String(r.verdict).toUpperCase())
if (r.verdict === 'error') { console.log('  ' + r.error); process.exit(2) }
if (r.error) console.log('  ' + r.error)
line('commitment', r.commitmentVerified === undefined ? 'not supplied' : r.commitmentVerified ? 'matches ✓' : 'MISMATCH ✕')
line('chain → root', r.chainLinksToRoot === undefined ? 'not supplied' : r.chainLinksToRoot ? 'links ✓' : 'DOES NOT LINK ✕')
if (r.game === COUNTING_GAME) {
  line('final count', r.finalCount + '   (measured from the clip, not derived)')
  line('recomputed', `${r.outcome}  ${r.lowerBound}–${r.upperBound}  (gap ${r.gap})`)
  line('published', `${r.publishedOutcome ?? '—'}  ${r.publishedLowerBound ?? '—'}–${r.publishedUpperBound ?? '—'}`)
  line('result match', yesNo(r.resultMatches))
  line('outcome draw', `${r.outcomeHex13} → ${r.target} of ${r.totalPpm} ppm`)
  for (const [label, hex13] of Object.entries(r.draws)) line('  ' + label, hex13)
} else if (r.game === MARBLE_GAME) {
  line('entrants', `${r.marbles.join(', ')}  (k=${r.k}${r.weighted ? ', weighted' : ''})`)
  line('recomputed', r.order.join(' · '))
  line('published', r.publishedOrder ? r.publishedOrder.join(' · ') : '—')
  line('result match', yesNo(r.resultMatches))
  line('order draw', `${r.draw} → index ${r.index}${r.weighted ? ` of ${r.totalPpm} ppm` : ` of ${r.permCount}`}`)
} else if (r.game === BIRDIE_GAME) {
  line('make rate', `${r.publishedMakeRatePpm} ppm  (${(r.makeRatePpm / 10000).toFixed(1)}% per putt${r.makeRatePpm !== r.publishedMakeRatePpm ? `, priced at the band edge ${r.makeRatePpm}` : ''}${r.catalogueSupplied ? ', bound to the catalogue' : ', as published — paste the catalogue to bind it'})`)
  line('recomputed', `${r.pattern}  (${r.order[0]})`)
  line('published', r.publishedOrder ? r.publishedOrder.join(' · ') : '—')
  line('order draw', `${r.draw} → index ${r.index} of ${r.totalPpm} ppm`)
  line('paytable hash', yesNo(r.paytableMatches) + '   ' + r.paytableHash)
  line('round type', r.roundType === undefined
    ? (r.publishedRoundType ? `${r.publishedRoundType} published — NOT recomputed (no weights supplied)` : 'plain (none published)')
    : `${r.roundType}  ← draw ${r.roundTypeDraw}   published ${r.publishedRoundType ?? '—'}   ${yesNo(r.roundTypeMatches)}`)
  line('card draw', `${r.cardDraw}   ${yesNo(r.cardDrawMatches)}`)
  if (r.catalogueSupplied) line('card', `${r.cardEntryId} (index ${r.cardIndex}, make rate ${r.cardMakeRatePpm})   catalogue hash ${yesNo(r.catalogueHashMatches)}`)
  line('result match', yesNo(r.resultMatches))
} else {
  line('recomputed', r.multiplier.toFixed(2) + '×')
  line('published', (r.publishedMultiplier ?? '—') + '×')
  line('result match', yesNo(r.multiplierMatches))
  line('r (decimal)', r.r.toFixed(15))
  line('hex (13)', r.hex13)
}
console.log('')
process.exit(r.verdict === 'mismatch' ? 1 : 0)
