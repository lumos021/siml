// src/rs.js - GF(2^8) Reed-Solomon encoder/decoder
// Primitive polynomial 0x11D (same as Python reedsolo library default).
// Corrects up to floor(NSYM/2) symbol-errors per codeword.
//
// rsEncode(data: Uint8Array|number[], nsym: number) → Uint8Array  [data ++ parity]
// rsDecode(codeword: Uint8Array|number[], nsym: number) → Uint8Array | null

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)

;(function () {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i
    x <<= 1; if (x & 256) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
})()

const mul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0
const inv = a => EXP[255 - LOG[a]]

// Evaluate big-endian polynomial at x (Horner)
const evalBE = (p, x) => { let y = 0; for (const c of p) y = mul(y, x) ^ c; return y }

// Multiply two big-endian polynomials
const polyMulBE = (p, q) => {
  const r = new Array(p.length + q.length - 1).fill(0)
  for (let i = 0; i < p.length; i++) for (let j = 0; j < q.length; j++) r[i+j] ^= mul(p[i], q[j])
  return r
}

// Generator poly g(x) = ∏(x + α^i) for i=0..nsym-1 (big-endian)
function makeGen (nsym) {
  let g = [1]
  for (let i = 0; i < nsym; i++) g = polyMulBE(g, [1, EXP[i]])
  return g
}

// Encode: returns Uint8Array of data.length + nsym bytes (data ++ parity)
function rsEncode (data, nsym) {
  const gen = makeGen(nsym)
  const msg = [...data, ...new Array(nsym).fill(0)]
  for (let i = 0; i < data.length; i++) {
    if (!msg[i]) continue
    for (let j = 1; j < gen.length; j++) msg[i+j] ^= mul(gen[j], msg[i])
  }
  return new Uint8Array([...data, ...msg.slice(data.length)])
}

// Berlekamp-Massey: given syndromes, returns error-locator poly in LE (sigma[0]=1)
function bm (synd) {
  let sigma = [1], B = [1], L = 0, b = 1
  for (let i = 0; i < synd.length; i++) {
    let d = synd[i]
    for (let j = 1; j < sigma.length; j++) if (i-j >= 0) d ^= mul(sigma[j], synd[i-j])
    B = [0, ...B]         // B ← x·B
    if (!d) continue
    const c = mul(d, inv(b))
    const ns = [...sigma]; while (ns.length < B.length) ns.push(0)
    for (let j = 0; j < B.length; j++) ns[j] ^= mul(c, B[j])
    if (2*L <= i) { L = i+1-L; B = sigma; b = d }
    sigma = ns
  }
  return sigma   // LE: sigma[k] = coeff of x^k
}

// Chien search: find positions k in [0,n) where sigma(α^{-k}) = 0
function chien (sigma, n) {
  const pos = []
  for (let k = 0; k < n; k++) {
    const xi = EXP[(255 - k) % 255]   // α^{-k}
    let v = 0, xp = 1
    for (const c of sigma) { v ^= mul(c, xp); xp = mul(xp, xi) }
    if (!v) pos.push(k)
  }
  return pos
}

// Decode: returns corrected data (without parity) or null if uncorrectable
function rsDecode (codeword, nsym) {
  try {
    const msg = Array.from(codeword)
    const n = msg.length
    const synd = Array.from({ length: nsym }, (_, i) => evalBE(msg, EXP[i]))
    if (synd.every(s => !s)) return new Uint8Array(codeword.slice(0, -nsym))

    const sigma = bm(synd)
    const ne = sigma.length - 1
    if (!ne || ne*2 > nsym) return null

    const errPos = chien(sigma, n)
    if (errPos.length !== ne) return null

    // Omega = S(x)·σ(x) mod x^nsym  (LE convolution, first nsym terms)
    const omega = new Array(nsym).fill(0)
    for (let k = 0; k < nsym; k++)
      for (let j = 0; j <= k && j < sigma.length; j++) omega[k] ^= mul(synd[k-j], sigma[j])

    // Formal derivative of sigma in LE: σ'[i] = σ[i+1] if i even, 0 if i odd
    const sd = Array.from({ length: sigma.length - 1 }, (_, i) => i%2===0 ? sigma[i+1] : 0)

    // Forney correction
    const corr = [...msg]
    for (const k of errPos) {
      const Xk  = EXP[k]
      const XkI = EXP[(255 - k) % 255]   // α^{-k}
      let omV = 0, sdV = 0, xp = 1
      for (const c of omega) { omV ^= mul(c, xp); xp = mul(xp, XkI) }
      xp = 1
      for (const c of sd)    { sdV ^= mul(c, xp); xp = mul(xp, XkI) }
      if (!sdV) return null
      corr[k] ^= mul(Xk, mul(omV, inv(sdV)))
    }

    // Verify
    if (Array.from({ length: nsym }, (_, i) => evalBE(corr, EXP[i])).some(s => s)) return null
    return new Uint8Array(corr.slice(0, -nsym))
  } catch { return null }
}

module.exports = { rsEncode, rsDecode }
