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

`npm test` runs every vector against `src/` **and** against the copy inlined in `verify.html`, so
the two can never disagree.

---

## Layout

```
verify.html                 self-contained browser verifier (inlines src/)
src/core.js                 SHA-256 chain, HMAC draw, uniform  (no deps)
src/mappers.js              r → crash multiplier; counting weights + boundaries; marble order
src/verify.js               game-agnostic verifier + verifyCrashRound() + verifyCountingRound()
                            + verifyMarbleRound() + verifyRound() dispatcher
vectors/fairness-vectors.json   the cross-language golden contract
test/run.mjs                runs the vectors against src/
test/verdict.mjs            verdict + input-handling edge cases (shared with the inline check)
test/check-inline.mjs       runs the vectors AND every verdict case against verify.html's copy
examples/                   a VERIFIED crash round, a MISMATCH round, a VERIFIED counting
                            round, a VERIFIED marble round, and a CLI runner (dispatches on `game`)
```

No build step, no dependencies, MIT-licensed. Read it, run it, port it.
