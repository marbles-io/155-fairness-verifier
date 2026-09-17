# 155 Provably-Fair Verifier

Independently verify that any 155 game round was **fair and fixed before you bet** —
by recomputing the result yourself, on your own machine, trusting no server.

- **[`verify.html`](verify.html)** — a single self-contained page. Download it and open it
  in any browser (works fully offline, from `file://`). Paste a round's public values, get a
  verdict. Nothing is sent anywhere.
- **[`src/`](src)** — the crypto and the per-game mappings, with no dependencies. This is the
  whole thing: `core.js` is ~120 lines and is shared by every game.
- **This README** — the algorithm in plain language, precise enough to reimplement in any
  language. If your independent implementation disagrees with this one, please get in touch.

The code here matches what the game runs, and both are locked to a shared set of
[golden test vectors](vectors/fairness-vectors.json) in CI. So "the verifier matches the
game" is not a promise — it's a test that fails the build if it's ever untrue.

> A **VERIFIED** verdict means *you* reproduced the outcome from a commitment the operator
> published **before** betting closed. It is proof, not a badge we grant ourselves.

---

## Quick start

**In a browser:** open `verify.html`, click **Load example**, then **Verify round**. Or paste
your own round's values (every field is shown to you at settlement).

**On the command line** (Node 20+, no `npm install` needed):

```bash
node examples/verify-example.mjs                        # the bundled example round → VERIFIED
node examples/verify-example.mjs examples/crash-mismatch.json      # a tampered round → MISMATCH
node examples/verify-example.mjs examples/counting-verified.json   # a counting round → VERIFIED
node examples/verify-example.mjs examples/marble-verified.json     # a marble race → VERIFIED
node examples/verify-example.mjs examples/birdie-verified.json     # a Birdie Time round → VERIFIED
npm test                                                # re-run all golden vectors
```

---

## The three verdicts

| Verdict | Meaning |
|---|---|
| ✅ **VERIFIED** | The result recomputes from the seed, **and** the commitment published when betting opened equals `sha256(seed)`. The outcome was fixed before you bet and nobody altered it. |
| 🟠 **INCONCLUSIVE** | The result recomputes (and, for v2, the seed links to the published chain root), but you did not supply the round-open commitment — so this alone can't prove the outcome was fixed *before* you bet. Add the commitment to upgrade to VERIFIED. |
| ❌ **MISMATCH** | The recomputation does **not** reproduce the published result, or the seed doesn't match the commitment / chain, or the published outcome weights don't sum to 1. Something is wrong — do not trust the round. |

VERIFIED and INCONCLUSIVE are deliberately distinct: a recompute without the round-open
commitment is not coloured green.

There is also a **CAN'T CHECK YET** state for input that is missing or malformed — a seed that
isn't hex, a chain index that isn't a whole number, a counting round with no `final_count`. It is
not a pass — this verifier fails **closed**.

---

## What a round exposes (all public)

| Value | Published | Meaning |
|---|---|---|
| `commitment` | when betting **opens** | `sha256(server_seed)` — locks the seed before you bet |
| `server_seed` | at **settlement** | the secret, now revealed (64 hex chars) |
| `chain_root_hash` | before the **batch** starts | the head of the pre-committed seed chain |
| `chain_index` | at settlement | this round's position in the chain |
| `beacon` | n/a for crash | public randomness for beacon-style games (empty for crash) |

**Crash** adds:

| Value | Published | Meaning |
|---|---|---|
| `multiplier` | at settlement | the result the game paid out on |
| `house_edge` | fixed / public | the RTP parameter (crash: `0.06`) |

**Counting games** (e.g. Rush Hour, Duck River, Snow Run — `game=vehicle_boundaries`) add:

| Value | Published | Meaning |
|---|---|---|
| `final_count` | at settlement | how many vehicles the clip actually contained — **measured**, see below |
| `gap` | when betting opens | the boundary width (default `3`), constant across outcomes |
| `outcome` | at settlement | `under` \| `range` \| `over` \| `jackpot` — the side that won |
| `lower_bound` / `upper_bound` | when betting opens | the boundaries you bet against |
| `outcomes` | fixed / public | the outcome names, canonical order |
| `weights_ppm` | fixed / public | their probabilities as integer parts-per-million, summing to `1000000` |

**Marble races** (e.g. Plinko, Snake, Coin Flip — `game=marble_order`) add:

| Value | Published | Meaning |
|---|---|---|
| `order` | at settlement | the **finishing order** — 1st, 2nd, … Kth entrant names, the result you bet on |
| `marbles` | when betting opens | the entrant names in canonical order (the effective set for this round) |
| `k` | fixed / public | how many finishing places (`1` for a single winner, `3` for a podium) |
| `weights_ppm` | fixed / public | **weighted single-winner games only** — one weight per marble, summing to `1000000` |
| `index` / `draw` | at settlement | the chosen permutation index and raw 13-hex draw — both seed-derived, optional cross-checks |

**Birdie Time** (`game=birdie`) — a marble race whose weights are not a fixed table but a function
of the round's **make rate**, plus two more seed-derived draws — adds:

| Value | Published | Meaning |
|---|---|---|
| `marbles` | when betting opens | the eight pattern entries, canonical order `HHH, HHM, HMH, MHH, HMM, MHM, MMH, MMM` (H = holed, M = missed, per putt) |
| `order` | at settlement | the winning pattern's entry — the result the count and exact markets pay on |
| `make_rate_ppm` | when betting opens | the card's per-putt make chance; **every price is a function of it** |
| `paytable_hash` | when betting opens | `sha256` of the priced board — binds the prices you saw to the make rate |
| `weights_ppm` / `index` / `draw` | at settlement | the pattern weights (recomputed from the make rate either way), the chosen index and the raw `order` draw — optional cross-checks |
| `round_type` | at settlement | `none` (plain) \| `frost` \| `fire` — the result the round-type side market pays on |
| `round_types_ppm` | fixed / public | the three round-type weights, e.g. `none:715000,frost:190000,fire:95000` — needed to recompute `round_type` (three integers in `none,frost,fire` order are accepted too) |
| `round_type_draw` | at settlement | the raw 13-hex `round_type` draw — optional cross-check |
| `card_draw` | at settlement | the raw 13-hex `card` draw — which catalogue entry priced the round |
| `card_index` / `catalogue_hash` / `catalogue_size` | at settlement | the drawn entry's index in the published catalogue, the catalogue's hash and its eligible size — checkable only with the **catalogue** (below) |
| `catalogue_version` | at settlement | which published catalogue registry row the round drew from — the one to paste as `catalogue` |
| `catalogue` | published per version | the catalogue registry row's `entries` — paste it to bind the make rate to the seed |

---

## Deep-linking into `verify.html`

A round page can hand off to the verifier pre-filled. Every parameter is a public
round value:

```
verify.html
  ?serverSeed=<64 hex>&observedCommitment=<64 hex>
  &chainRootHash=<64 hex>&chainIndex=<int>&beacon=<hex pairs or empty>
  # crash (the default — `game` absent means crash):
  &houseEdge=0.06&multiplier=5.16
  # counting:
  &game=vehicle_boundaries
  &finalCount=14&gap=3&outcome=under&lowerBound=16&upperBound=19
  &outcomes=under,range,over,jackpot&weightsPpm=250000,500000,200000,50000
  # marble races:
  &game=marble_order
  &marbles=black,blue,green,orange,red,sky,white,yellow&k=3&order=green,red,white
  &index=106&draw=5142bd05c2e59
  # …weighted single-winner games add &weightsPpm=471700,377400,94300,47200,9400 (k=1)
  # Birdie Time:
  &game=birdie
  &marbles=<8 pattern ids>&makeRatePpm=500000&order=<winning id>&paytableHash=<64 hex>   # observedOrder is accepted for order
  &roundType=frost&roundTypeDraw=bee16e4749787&roundTypesPpm=none:715000,frost:190000,fire:95000
  &cardDraw=758f351ff7aa2&cardIndex=1&catalogueHash=<64 hex>&catalogueSize=3
  # …plus the optional index / draw / weightsPpm cross-checks; the catalogue itself is pasted, not linked
```

`game` is the only discriminator. **Absent (or anything unrecognised) means crash**,
so every link ever minted keeps working.

---

## The algorithm (reimplement it yourself)

The scheme is **v2**: a reverse hash chain of secret seeds whose head (`root`) is committed
before any round is played, plus a domain-separated HMAC that turns a seed into the round's
outcome. Every player in a round shares one outcome, so there is no per-player "client seed";
the pre-committed chain is what binds the sequence of seeds.

Everything uses **SHA-256**, and every hash/HMAC output is written as its **lowercase**
hex digest (`hexdigest()`). There are **four** checks. A few subtle rules trip up naive
re-implementations — they're flagged **⚠**.

### 1. Commitment binds the seed

```
recomputed_commitment = sha256( ASCII bytes of the seed's hex STRING )
```

⚠ **Hash the seed's hex text, not its decoded bytes.** The seed `"6f7081…"` is hashed as the
64-character ASCII string, *not* as 32 decoded bytes. (`echo -n 6f7081… | sha256sum`.)

VERIFIED requires `recomputed_commitment == commitment_published_at_open`.

### 2. The seed is link *N* of the pre-committed chain

Seeds form a reverse chain: `seed[i] = sha256(seed[i+1])` (ASCII, as above), and `seed[0]` is the
published `root`. Round *N* uses `seed[N]`. So hashing the revealed seed `chain_index` times must
reproduce the root:

```
h = server_seed
repeat chain_index times:  h = sha256( ASCII text of h )   # lowercase hexdigest, re-hashed as text
assert h == chain_root_hash
```

⚠ **Re-hash the lowercase hex string.** Each `sha256()` returns a lowercase hex digest, and it
is *that exact lowercase string* that gets hashed on the next iteration. Uppercasing an
intermediate hash breaks the walk (`sha256("ABAB…") ≠ sha256("abab…")`).

Because the root is published before the batch, this proves the seed was pre-committed to its exact
position — the operator cannot swap in a different seed after seeing the bets.

### 3. The seed determines the result

```
message = beacon + ":" + label + ":" + str(index)      # crash: "" + ":crash:0"  ==  ":crash:0"
digest  = HMAC_SHA256( key = DECODED seed bytes, msg = ASCII bytes of message )   # lowercase hexdigest
hex13   = first 13 hex characters of the hex digest    # 52 bits
r       = int(hex13, 16) / 2**52                        # a float in [0, 1)
```

`index` is decimal-stringified (`0`, not zero-padded). `label` is `crash` for the crash point.

⚠ **The HMAC key is the *decoded* seed bytes** (`bytes.fromhex(seed)`), the opposite of step 1
which hashes the *text*. Keep the two distinct. ⚠ Take exactly **13 hex characters** (52 bits, the
exact mantissa of an IEEE-754 double) and divide by `2**52`.

For crash: `beacon = ""`, `label = "crash"`, `index = 0`. The empty beacon **keeps** its leading
colon, so the message is literally `:crash:0`.

### 4. `r` maps to the crash multiplier

```
raw        = max( 1.0, (1.0 - house_edge) / (1.0 - r) )
multiplier = floor( raw * 100 + 0.5 ) / 100            # half-up to 2 decimals
```

⚠ **Round half-up**, `floor(x*100 + 0.5)/100` — *not* banker's rounding and *not* naive
`round(x, 2)` (which would turn `2.125` into `2.12`; the paid value is `2.13`). VERIFIED requires
`multiplier == published_multiplier`.

That's it. If your four numbers match ours, the round is provably fair.

---

## Counting games (`game=vehicle_boundaries`)

For the counting games, the round's `final_count` is a **measured input** and everything else —
the winning outcome and the boundaries around the count — is **derived from the committed seed**.
That derivation is what you verify: given the seed and the count, the published outcome and
boundaries must recompute exactly.

Steps 1 and 2 (commitment, chain) are **identical** to crash. Only the mapping differs, and it
uses **integers end to end** — no float ever touches a decision.

⚠ **`final_count` is an input, not a derivation.** It is measured from the clip by computer
vision, so a verifier cannot recompute it — it recomputes the *boundaries the operator built
around it*. A round that omits the final count cannot be checked at all (the verifier says so;
it never passes it).

### A. Integer weights

```
OUTCOME_ORDER = ("under", "range", "over", "jackpot")     # canonical, append-only forever
order   = [o for o in OUTCOME_ORDER if o in probabilities]  # NEVER iterate the probabilities
w[i]    = floor(p[order[i]] * 1_000_000 + 0.5)              # parts-per-million
assert sum(w) == 1_000_000                                  # RAISE — never renormalise
```

⚠ **Iterate `OUTCOME_ORDER`, not the probability object.** JS object key order and Go map order
are not the order the table was written in, and the cumulative pick below depends on a fixed one.

⚠ **The sum guard is a hard failure, not a nudge.** A probability table must sum to exactly
`1_000_000` ppm. Anything else is reported as a MISMATCH; the verifier never renormalises.

### B. The uniform integer draw

```
scaled_index(hex13, n) = (int(hex13, 16) * n) >> 52
```

⚠ **Integers only.** With `n = 1_000_000` the product reaches ~2^72, so JS must use `BigInt` and
Go must use `math/big`. And it is *not* `floor(uniform * n)` — the two disagree at boundaries.

### C. The winning outcome

Every draw is `draw13(seed, beacon, LABEL, 0)` — step 3 above, with its own label and **index
always `0`**:

```
target = scaled_index( draw13(seed, beacon, "outcome", 0), sum(w) )     # scale by the SUM
walk the cumulative buckets in `order`; the bucket containing `target` wins
```

⚠ Scale by the actual weight **sum**, not by the `1_000_000` constant.

### D. The boundaries

One further draw — **only** the one for the branch that won (`draws` therefore holds exactly
two entries: `outcome` plus that branch):

| outcome | label | boundaries |
|---|---|---|
| `under` | `under_offset` | `lower = count + 1 + scaled_index(h, 2)`, `upper = lower + gap` |
| `over` | `over_offset` | `upper = count − (1 + scaled_index(h, 2))`, `lower = upper − gap` |
| `range` | `range_offset` | `offset = 1 + scaled_index(h, gap−1)` when a jackpot outcome exists (4-way: the count is **strictly inside**), else `offset = scaled_index(h, gap+1)` (3-way: bounds **inclusive**). `lower = count − offset`, `upper = lower + gap` |
| `jackpot` | `jackpot_side` | `scaled_index(h, 2) == 0` → `(count, count + gap)`, else `(count − gap, count)` |

Then, unconditionally:

```
lower = max(1, lower)
upper = max(lower + gap, upper)
```

⚠ **Apply the clamps.** They are part of the published bounds, not a caller's concern.

⚠ **Never compute all five draws.** Each branch owns its own label, so adding a future draw can
never shift an existing one — but only if you draw lazily.

`gap` is **constant across outcomes** by design, so the boundary width carries no information
about which outcome won.

VERIFIED requires the recomputed `outcome`, `lower_bound` **and** `upper_bound` to all equal the
published ones — plus the commitment, exactly as for crash.

## Marble races (`game=marble_order`)

The marble races settle to an **ordered finishing list** of `k` names drawn from `m` entrants
(`k = 1` for the single-winner games, `k = 3` for the podium games). Unlike the counting games —
whose `final_count` is measured — the finishing order is **fully seed-derived**: a single draw
decides the whole order.

Steps 1 and 2 (commitment, chain) are **identical** to crash. The mapping uses the same
`scaled_index` integer draw from the counting section (`(int(hex13,16) * n) >> 52`, BigInt / `math/big`).

One draw decides everything — step 3 above, at label **`order`, index `0`**:

```
draw = draw13(seed, beacon, "order", 0)
```

### Equal games (no weights)

Enumerate the `k`-permutations of `range(m)` in **canonical lexicographic order**, then index into them:

```
result = [[]]
repeat k times:
    result = [ prefix + [i]  for prefix in result  for i in range(m)  if i not in prefix ]
index = scaled_index(draw, len(result))              # len == m! / (m−k)!
order = [ marbles[i] for i in result[index] ]
```

⚠ **Build the permutations explicitly, not with a library `permutations()` call.** The canonical
order *is* the contract — the engine picks an index into this exact list, so a differently-ordered
enumeration (even one that contains the same permutations) reproduces the wrong order.

### Weighted single-winner games (`k = 1`)

Weighted single-winner games publish an index-aligned `weights_ppm` (one per marble, summing
to `1_000_000`). The single winner is a cumulative-bucket pick, same as the counting outcome:

```
assert k == 1 and len(weights_ppm) == m and sum(weights_ppm) == 1_000_000   # else FAIL, never renormalise
target = scaled_index(draw, 1_000_000)
walk the cumulative buckets over marbles; the bucket containing `target` is the winner
order = [ marbles[winner] ]
```

⚠ **The weight-sum guard is a hard failure.** A weighted table must sum to exactly `1_000_000`
ppm; anything else is a MISMATCH and is never renormalised. The published integers are what you
verify.

VERIFIED requires the recomputed `order` to **exactly** equal the published one — same names, same
positions — plus the commitment, exactly as for crash. A published `index` or `draw` that disagrees
with the recomputation is a MISMATCH; for distinct marbles the order and the index determine each
other, so this can never contradict itself.

## Birdie Time (`game=birdie`)

A Birdie round is **three independent draws over one committed seed**, each under its own label at
index `0` and with the **empty beacon** (Birdie has none):

```
card_draw       = draw13(seed, "", "card", 0)          # which catalogue entry priced the round
order_draw      = draw13(seed, "", "order", 0)         # which of the 8 putt patterns happened
round_type_draw = draw13(seed, "", "round_type", 0)    # plain / frost / fire (the side market)
```

Steps 1 and 2 (commitment, chain) are identical to crash. What is new is that the pattern's weights
are not a published table but a **function of the make rate**, so a verifier recomputes them:

### A. The board from the make rate

`p = clamp(make_rate_ppm, 150000, 850000) / 1e6`, `q = 1 − p`. The eight pattern weights in
`PATTERNS` order are `p³, p²q, p²q, p²q, pq², pq², pq², q³`, taken to integer ppm by
largest-remainder apportionment with an index tie-break:

```
scaled = [p*p*p, p*p*q, p*p*q, p*p*q, p*q*q, p*q*q, p*q*q, q*q*q] × 1_000_000   # EXPLICIT products, never pow()
floors = floor(each)
give the (1_000_000 − sum(floors)) leftover units to the largest fractional parts; ties → lowest index
```

⚠ **Multiply, never `pow`.** `pow()` differs by an ulp between engines, and one ulp can move the
leftover unit between patterns. The game's own implementations and this one agree at every make rate
in the band; [`vectors/birdie-weights-band.json`](vectors/birdie-weights-band.json) pins 701 of them.

Every priced option pays `1 / (p_option · (1 + margin))` at RTP `950000` ppm
(`margin = 1e6/950000 − 1 = 0.05263157894736836`, one literal on every side). The ten priced options,
in this order, are

```
OPTIONS = (IN3, IN2, IN1, IN0, HHM, HMH, MHH, HMM, MHM, MMH)   # four counts, then the six bettable patterns
IN3 = HHH        IN2 = HHM + HMH + MHH        IN1 = HMM + MHM + MMH        IN0 = MMM
```

`HHH` and `MMM` are never priced: they are the patterns that make the exact market sum to one. The
paytable hash that was published at round open is

```
preimage = "950000|<8 weights in PATTERNS order, comma-joined>|<10 terms in OPTIONS order, comma-joined>"
term     = floor(multiplier × 100 + 0.5)                # half-up on the exact float — never round()
paytable_hash = sha256(preimage)                       # ASCII, like the chain
```

Recomputing it from the make rate proves the prices you saw came from this board.

### B. The pattern

Exactly the weighted single-winner marble draw above: `marble_order(seed, marbles, 1, weights_ppm)`
at label `order` — `target = scaled_index(order_draw, 1_000_000)`, walk the cumulative pattern
buckets. The result the count and exact markets settle on.

### C. The round type

`weighted_pick(round_type_draw, names, weights)` where `names` is `none, frost, fire` restricted to
the keys present in the published `round_types_ppm`, and the target is scaled to the **actual** weight
sum. A published `frost` or `fire` with no weights to recompute it from is **not** green — a paid
result nobody checked is not a verified round. A published `none` with no weights (a round with no
side market) has nothing to check and does not block.

### D. The card

`weighted_pick(card_draw, entry_ids, weight_ppm)` over the published catalogue's **eligible** entries
sorted by `entry_id`. The catalogue commitment is

```
catalogue_hash = sha256( "\n".join( f"{entry_id}|{golfer_id}|{location_id}|{make_rate_ppm}|{weight_ppm}"  for each ELIGIBLE entry, sorted by entry_id ) )
```

— exactly the five fields that price a round, never presentation, over the eligible entries only
(`catalogue_size` is that same count; a registry row marks the others `eligible: false`). With the catalogue supplied the
verifier checks the hash, the drawn index **and that the drawn card's `make_rate_ppm` is the make rate
the board was priced from** — the binding that turns "given the published make rate" into "from the
seed". Without it, `card_draw` is still recomputed and compared, and the make rate is taken as
published; the report says so.

VERIFIED requires the commitment, the recomputed pattern to equal the published one, and every
published value that *can* be checked to check out (weights, paytable hash, index, draws, round type,
card index, catalogue hash and size). Any one of them disagreeing is a MISMATCH.

### Other games

`verify.js` is game-agnostic: steps 1–3 are shared, and each game supplies only its step-4
`r → outcome` mapping under its own `label`. Beacon-style games add the public
[drand quicknet](https://drand.love) randomness into `beacon` (its pinned constants are in
`src/core.js`); crash uses none.

---

## Golden test vectors

[`vectors/fairness-vectors.json`](vectors/fairness-vectors.json) is the cross-language contract —
the same file the game and the in-game verifier are tested against. A few anchors you
can reproduce by hand:

- seed `"0000…0000"` (64 zero chars) → HMAC over `:crash:0` → `hex13 = 743d80c1d78ca` → `r ≈ 0.4540…` → (house_edge `0.06`) → crash **1.72×**
- chain: `sha256("abab…abab")` applied 3× → root `9968162c0cfdb6f1…`
- rounding: `2.125 → 2.13`, `1.005 → 1.00`, `99.999 → 100.00`
- counting: seed `"b157310d…6ccf"`, `:outcome:0` → `hex13 = 0836d987b79f9` → target `32086` of
  `1000000` ppm → the `under` bucket (`0–299999`) → `under_offset` → bounds **16 – 19** at a
  final count of 14

The `vehicle_boundaries` block covers all four outcomes, 3-way (no jackpot) and 4-way tables,
the count-at-the-betting-floor cases, both clamp branches, a non-empty beacon and a non-default
gap. The `marble_order` block covers equal podium (`k=3`) and single-winner (`k=1`) games,
weighted single-winner tables, a non-empty beacon, the `k==m` full-permutation edge and the
single-entrant forced win.

[`vectors/birdie-vectors.json`](vectors/birdie-vectors.json) is the Birdie contract — generated by the
game engine and shared with the backend: four priced boards with every multiplier bit-equal, the
half-up hash terms, the catalogue hash, and the card / order / round-type draws on one seed (three
labels, three different values). [`vectors/birdie-weights-band.json`](vectors/birdie-weights-band.json)
is the 701-point make-rate band table.

`npm test` runs every vector against `src/` **and** against the copy inlined in `verify.html`, so
the two can never disagree.

---

## Layout

```
verify.html                 self-contained browser verifier (inlines src/)
src/core.js                 SHA-256 chain, HMAC draw, uniform  (no deps)
src/mappers.js              r → crash multiplier; counting weights + boundaries; marble order;
                            birdie board / paytable hash / card / round type
src/verify.js               game-agnostic verifier + verifyCrashRound() + verifyCountingRound()
                            + verifyMarbleRound() + verifyBirdieRound() + verifyRound() dispatcher
vectors/fairness-vectors.json   the cross-language golden contract
vectors/birdie-vectors.json     the Birdie contract (engine-generated)
vectors/birdie-weights-band.json  the 701-point make-rate band table
test/run.mjs                runs the vectors against src/
test/verdict.mjs            verdict + input-handling edge cases (shared with the inline check)
test/check-inline.mjs       runs the vectors AND every verdict case against verify.html's copy
examples/                   a VERIFIED crash round, a MISMATCH round, a VERIFIED counting
                            round, a VERIFIED marble round, a VERIFIED birdie round, and a CLI
                            runner (dispatches on `game`)
```

No build step, no dependencies, MIT-licensed. Read it, run it, port it.
