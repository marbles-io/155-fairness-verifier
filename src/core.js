// Provably-fair core (v2) — dependency-free ES module.
// Locked to vectors/fairness-vectors.json — run `node test/run.mjs`.
// No game-specific logic here; result mapping is in mappers.js.
// Uses only the Web Crypto API (browser + Node 20+) and BigInt.

const R_DENOM = 2 ** 52 // exact IEEE-754 double mantissa (Bustabit convention)

// Pinned drand quicknet constants (spec §3.2) — used only by beacon games; crash
// has no beacon. Never fetched at verify-time. publicKey is the 96-byte BLS12-381
// G2 group key (verify a beacon signature with @noble/curves if you check those).
export const DRAND_QUICKNET = {
  beaconId: 'quicknet',
  chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  publicKey:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c' +
    '8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb' +
    '5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  scheme: 'bls-unchained-g1-rfc9380',
  genesis: 1692803367,
  period: 3
}

const BEACON_RE = /^(?:[0-9a-f]{2})*$/ // empty OR even-length lowercase hex
const LABEL_RE = /^[a-z_]+$/

function subtle() {
  const s = globalThis.crypto?.subtle
  if (!s)
    throw new Error(
      'Web Crypto (crypto.subtle) unavailable — open this over https:// or file://, or run in Node 20+.'
    )
  return s
}

function toHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`)
  // Fail CLOSED on non-hex, matching the engine's bytes.fromhex (which raises).
  // Without this, parseInt silently yields NaN->0 and a garbage seed would
  // produce a bogus "result" instead of an error.
  if (!/^[0-9a-f]*$/i.test(hex)) throw new Error(`non-hex input: ${hex}`)
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

// SHA-256 of the ASCII hex STRING (not the decoded bytes). This is the chain
// link AND the per-round commitment. Do NOT hex-decode the seed for this step.
export async function sha256Ascii(hexStr) {
  return toHex(await subtle().digest('SHA-256', new TextEncoder().encode(hexStr)))
}

// Per-round commitment == the chain link == the previous seed in the chain.
export async function serverSeedHash(serverSeed) {
  return sha256Ascii(serverSeed)
}

// True iff sha256Ascii(serverSeed) === prevHash (the previous link / the root).
export async function verifyLink(serverSeed, prevHash) {
  return (await sha256Ascii(serverSeed)) === prevHash
}

// Apply sha256Ascii chainIndex times -> the published chain root.
// Round j uses seed[j]; sha256Ascii applied j times returns seed[0] = the root.
export async function walkToRoot(serverSeed, chainIndex) {
  let h = serverSeed
  for (let i = 0; i < chainIndex; i++) h = await sha256Ascii(h)
  return h
}

function assertDomain(beacon, label, i) {
  if (!BEACON_RE.test(beacon))
    throw new Error(`bad beacon (empty or lowercase hex pairs): ${beacon}`)
  if (!LABEL_RE.test(label)) throw new Error(`bad label (^[a-z_]+$): ${label}`)
  if (!Number.isInteger(i) || i < 0) throw new Error(`bad i (non-negative int): ${i}`)
}

// HMAC-SHA256(key = HEX-DECODED seed bytes, msg = utf-8 message) as hex.
// NOTE the asymmetry vs sha256Ascii: the HMAC KEY is the decoded seed bytes,
// while the chain/commitment hashes the ascii hex string. This trips up naive
// re-implementations — keep them distinct.
export async function hmacSha256Hex(serverSeed, message) {
  const key = await subtle().importKey(
    'raw',
    hexToBytes(serverSeed),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await subtle().sign('HMAC', key, new TextEncoder().encode(message))
  return toHex(sig)
}

// 13-hex (52-bit) domain-separated draw. preimage = `${beacon}:${label}:${i}`.
// An empty beacon KEEPS its leading delimiter -> ":crash:0". HMAC key = decoded seed.
export async function draw13(serverSeed, beacon, label, i) {
  assertDomain(beacon, label, i)
  return (await hmacSha256Hex(serverSeed, `${beacon}:${label}:${i}`)).slice(0, 13)
}

// Uniform float in [0, 1) from the 52-bit draw.
export async function uniform(serverSeed, beacon, label, i) {
  return parseInt(await draw13(serverSeed, beacon, label, i), 16) / R_DENOM
}

// The drand round pinned as the first round at/after betting-close (beacon games).
export function beaconRound(bettingCloseUnixS) {
  return Math.floor((bettingCloseUnixS - DRAND_QUICKNET.genesis) / DRAND_QUICKNET.period) + 1
}

export const R_DIVISOR = R_DENOM
