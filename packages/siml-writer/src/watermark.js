// src/watermark.js - DCT-QIM Watermark with Reed-Solomon ECC + true soft-decision
// Bitstream: SYNC(16) ‖ RS_encode(payload ‖ CRC16)(RS_NSYM parity appended)
// Extraction: soft-decision majority → RS decode → CRC verify
// ↳ Matches python reference: fixed-step QIM + soft-decision + RS + CRC (spec §4.4)

const { rsEncode, rsDecode } = require('./rs')

const SYNC_TAG = 0xD4B3     // 16-bit sync tag (spec §4.3 validity oracle)
const CANONICAL_WIDTH = 1024
const Q = 26                // QIM step size
// Guaranteed embed-time decode margin (d_wrong - d_correct) in coefficient
// units, 0..Q. Q = full snap (max robustness, max grain); smaller = less
// visible distortion. Ratified by the sweep in scripts/compare-embedders.js
// against the pinned C-T1 floors. Env override exists ONLY for that sweep.
const QIM_MARGIN = Number(process.env.SIML_QIM_MARGIN ?? 18)
// Textured-only placement: embed marks only blocks with std-dev >= EMBED
// threshold (smooth skies stay byte-untouched); the decoder includes blocks
// with std-dev >= DECODE threshold - a guard band, since attacks mostly
// reduce texture. Selection never shifts bit positions (assignment is
// positional), so a borderline block costs one vote, never a desync.
const TEXTURE_EMBED_STDDEV = 8
const TEXTURE_DECODE_STDDEV = 3
const MIN_TEXTURED_REPS = 8 // average redundancy floor for textured-only placement
const MIN_POSITION_VOTES = 4 // AND every bit position must get at least this many textured votes
// Dual-band fallback for low-texture images: smooth blocks embed at half
// quantizer strength (exact snap on Q_SMOOTH-spaced levels - the visually
// clean amplitude, measured JPEG floor ~q40, comfortably covering
// messaging-grade q70+), textured blocks keep the full Q=26 signal. The
// decoder classifies blocks the same way (guard-banded) and votes with the
// matching quantizer per block; every decode is still sync+RS+CRC gated.
const Q_SMOOTH = 13
const RS_NSYM = 4           // Reed-Solomon parity symbols (corrects up to 2 byte errors)
const T1_CAPACITY = 16      // payload bytes the watermark carries (spec §4.4/§4.5.1)

// CRC-16/CCITT-FALSE over the payload bytes. The sync tag only proves the grid
// re-locked; the CRC is what lets us reject a bit-errored read instead of
// surfacing a confidently-wrong value (spec §4.6 hard rule). 16 bits keeps the
// bitstream short so per-bit redundancy stays high.
function crc16(bytes) {
  let crc = 0xFFFF
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF
    }
  }
  return crc & 0xFFFF
}

// Precompute DCT cosine terms for speed
const cosTable = new Float32Array(8 * 8);
for (let u = 0; u < 8; u++) {
  for (let x = 0; x < 8; x++) {
    cosTable[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
}

function cCoeff(w) {
  return w === 0 ? 1 / Math.sqrt(2) : 1;
}

// 1D DCT on 8x8 block (in-place along rows/cols)
function dct2d(block) {
  const out = new Float32Array(64)
  for (let u = 0; u < 8; u++) {
    const cu = cCoeff(u)
    for (let v = 0; v < 8; v++) {
      const cv = cCoeff(v)
      let sum = 0
      for (let x = 0; x < 8; x++) {
        const cosX = cosTable[u * 8 + x]
        for (let y = 0; y < 8; y++) {
          sum += block[x * 8 + y] * cosX * cosTable[v * 8 + y]
        }
      }
      out[u * 8 + v] = 0.25 * cu * cv * sum
    }
  }
  return out
}

function idct2d(dctBlock) {
  const out = new Float32Array(64)
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let sum = 0
      for (let u = 0; u < 8; u++) {
        const cu = cCoeff(u)
        const cosX = cosTable[u * 8 + x]
        for (let v = 0; v < 8; v++) {
          sum += cu * cCoeff(v) * dctBlock[u * 8 + v] * cosX * cosTable[v * 8 + y]
        }
      }
      out[x * 8 + y] = 0.25 * sum
    }
  }
  return out
}

/**
 * Converts RGB to Y (luminance) in-place or returns Y channel.
 */
function rgbToY(rgba, width, height) {
  const Y = new Float32Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4]
    const g = rgba[i * 4 + 1]
    const b = rgba[i * 4 + 2]
    // Standard BT.601 Y calculation
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b
  }
  return Y
}

/**
 * Reconstructs RGB from perturbed Y channel in-place.
 */
function updateRGBWithY(rgba, Y, width, height) {
  for (let i = 0; i < width * height; i++) {
    const oldR = rgba[i * 4]
    const oldG = rgba[i * 4 + 1]
    const oldB = rgba[i * 4 + 2]
    const oldY = 0.299 * oldR + 0.587 * oldG + 0.114 * oldB
    const delta = Y[i] - oldY

    // Apply the luminance delta to RGB channels (preserves chromaticity).
    // Math.round is explicit: plain Buffers truncate and Uint8ClampedArrays
    // round, so without it Node and browser embeds diverge subtly.
    rgba[i * 4]     = Math.round(Math.max(0, Math.min(255, oldR + delta)))
    rgba[i * 4 + 1] = Math.round(Math.max(0, Math.min(255, oldG + delta)))
    rgba[i * 4 + 2] = Math.round(Math.max(0, Math.min(255, oldB + delta)))
  }
}

/**
 * Encodes payload bits into RGBA buffer in-place.
 *
 * @param {Uint8Array} rgba - Flat RGBA array
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} payloadBytes
 */
/**
 * Embeds payload into the image via DCT-QIM.
 * Bitstream: SYNC(16) ‖ RS_encode(payload ‖ CRC16) bits, tiled across all 8×8 blocks.
 */
// Per-block luminance standard deviation - the texture measure that drives
// PLACEMENT (not step size; the step stays fixed, so the §4.4 adaptive-step
// trap does not apply).
function nextPrime (n) {
  const isP = (k) => { for (let d = 2; d * d <= k; d++) if (k % d === 0) return false; return k > 1 }
  while (!isP(n)) n++
  return n
}

function blockStddev(Y, width, bx, by) {
  let mean = 0
  for (let x = 0; x < 8; x++)
    for (let y = 0; y < 8; y++)
      mean += Y[((by * 8 + x) * width) + (bx * 8 + y)]
  mean /= 64
  let v = 0
  for (let x = 0; x < 8; x++)
    for (let y = 0; y < 8; y++) {
      const d = Y[((by * 8 + x) * width) + (bx * 8 + y)] - mean
      v += d * d
    }
  return Math.sqrt(v / 64)
}

function embedWatermark(rgba, width, height, payloadBytes) {
  // 1. CRC over raw payload
  const crc = crc16(payloadBytes)
  // 2. RS-encode [payload ‖ CRC_hi ‖ CRC_lo] → adds RS_NSYM parity bytes
  const rsInput = [...payloadBytes, (crc >> 8) & 0xFF, crc & 0xFF]
  const rsCoded = rsEncode(rsInput, RS_NSYM)  // Uint8Array, length = rsInput.length + RS_NSYM

  // 3. Pack bitstream: SYNC tag first, then RS-coded bytes
  const bits = []
  for (let i = 0; i < 16; i++) bits.push((SYNC_TAG >> (15 - i)) & 1)
  for (const byte of rsCoded) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1)
  // Pad to a prime length: coprime to every row stride, so sequential
  // assignment covers every position from every column and any image size.
  while (bits.length < nextPrime(bits.length)) bits.push(0)

  // TEXTURED-ONLY PLACEMENT: smooth blocks (skies, gradients) are where the QIM
  // ripple is visible and the eye is most sensitive, so when the image has
  // enough textured blocks to carry the stream with solid redundancy, smooth
  // blocks are left BYTE-UNTOUCHED and the payload rides only under texture.
  // Bit assignment is POSITIONAL (blockIndex % bitLength), never selection-
  // order, so an embedder/decoder disagreement about any single block costs one
  // vote, not a desync - and the sync tag + CRC still gate every decode.
  // Low-texture images fall back to full coverage (the classic recipe).
  // Block modes: 0 = skip (byte-untouched), 1 = full-band Q, 2 = smooth-band
  // Q_SMOOTH. Texture-rich images: textured blocks full-band, smooth skipped
  // (skies byte-untouched). Low-texture images: dual-band - textured blocks
  // full-band, smooth blocks half-strength (visually clean, messaging-grade
  // survival) so coverage is universal without visible grain.
  const blocksX = Math.floor(width / 8)
  const blocksY = Math.floor(height / 8)
  const Y0 = rgbToY(rgba, width, height)
  const mask = new Uint8Array(blocksX * blocksY)
  let eligible = 0
  for (let by = 0; by < blocksY; by++)
    for (let bx = 0; bx < blocksX; bx++)
      if (blockStddev(Y0, width, bx, by) >= TEXTURE_EMBED_STDDEV) {
        mask[by * blocksX + bx] = 1
        eligible++
      }
  // Selective placement requires MINIMUM per-position coverage, not average:
  // textured blocks cluster spatially, and a bit position with zero votes kills
  // the whole decode no matter how many total blocks are marked.
  const posVotes = new Uint32Array(bits.length)
  for (let i = 0; i < mask.length; i++) if (mask[i]) posVotes[i % bits.length]++
  let minVotes = Infinity
  for (let i = 0; i < bits.length; i++) if (posVotes[i] < minVotes) minVotes = posVotes[i]
  const selective = eligible >= MIN_TEXTURED_REPS * bits.length && minVotes >= MIN_POSITION_VOTES
  if (!selective) {
    // dual-band: every unmarked block becomes a smooth-band carrier
    for (let i = 0; i < mask.length; i++) if (!mask[i]) mask[i] = 2
  }
  const placement = selective ? 'textured' : 'dual-band'

  // Multiple passes fight saturation clipping: applying the luminance delta to
  // near-white/near-black pixels clips, which drags the (2,1) coefficient off
  // its quantization level. Re-embedding on the clamped result re-pushes those
  // blocks. The mask is computed ONCE from the original pixels and reused, so
  // all passes mark the same blocks.
  const EMBED_PASSES = 3
  for (let pass = 0; pass < EMBED_PASSES; pass++) {
    embedPass(rgba, width, height, bits, mask)
  }
  return { placement, markedBlocks: selective ? eligible : blocksX * blocksY, totalBlocks: blocksX * blocksY }
}

function embedPass(rgba, width, height, bits, mask) {
  const Y = rgbToY(rgba, width, height)
  const blocksX = Math.floor(width / 8)
  const blocksY = Math.floor(height / 8)
  const bitLength = bits.length
  const block = new Float32Array(64)

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const blockIndex = by * blocksX + bx
      const mode = mask[blockIndex]
      if (!mode) continue // skipped block: byte-untouched
      for (let x = 0; x < 8; x++)
        for (let y = 0; y < 8; y++)
          block[x * 8 + y] = Y[((by * 8 + x) * width) + (bx * 8 + y)]

      const dct = dct2d(block)
      const targetBit = bits[blockIndex % bitLength] // prime-length stream: full coverage
      const coeffVal = dct[2 * 8 + 1]
      // Full band: margin-band QIM on Q-spaced levels (guaranteed margin).
      // Smooth band: exact snap on Q_SMOOTH-spaced levels (half amplitude,
      // visually clean; measured floor ~q40, covers messaging-grade q70+).
      const q = mode === 2 ? Q_SMOOTH : Q
      let quantum = Math.round(coeffVal / q)
      const isEven = (quantum % 2 + 2) % 2 === 0  // guard against negative mod
      if (isEven !== (targetBit === 0)) {
        // nearest correct-parity level, toward the residual
        quantum += (coeffVal / q - quantum) >= 0 ? 1 : -1
      }
      const level = quantum * q
      if (mode === 2) {
        dct[2 * 8 + 1] = level
      } else {
        const band = (Q - QIM_MARGIN) / 2
        const off = Math.max(-band, Math.min(band, coeffVal - level))
        dct[2 * 8 + 1] = level + off
      }
      const reconstructed = idct2d(dct)
      for (let x = 0; x < 8; x++)
        for (let y = 0; y < 8; y++)
          Y[((by * 8 + x) * width) + (bx * 8 + y)] = reconstructed[x * 8 + y]
    }
  }
  updateRGBWithY(rgba, Y, width, height)
}

/**
 * Extracts payload bits from RGBA buffer.
 *
 * @param {Uint8Array} rgba - Flat RGBA array
 * @param {number} width
 * @param {number} height
 * @param {number} payloadByteLength - Expected payload byte length
 * @returns {Uint8Array|null} Extracted payload or null if sync tag mismatches
 */
/**
 * Extracts payload from image pixels.
 * Uses true soft-decision voting (margin sum) then RS decode + CRC verify.
 */
function extractWatermark(rgba, width, height, payloadByteLength) {
  const Y = rgbToY(rgba, width, height)
  const blocksX = Math.floor(width / 8)
  const blocksY = Math.floor(height / 8)

  // RS-coded length: payload + 2 CRC bytes + RS_NSYM parity
  const rsByteLen = payloadByteLength + 2 + RS_NSYM
  const bitLength = nextPrime(16 + rsByteLen * 8)  // sync + RS bits, prime-padded

  // Three attempts, each fully gated by sync + RS + CRC (the fail-loud oracle):
  // 1. 'textured' - textured blocks only at Q. Correct for textured-placement
  //    embeds; also a valid consistent subset for full-coverage embeds.
  // 2. 'dual'     - per-block quantizer by the same texture classifier the
  //    embedder used (textured -> Q, smooth -> Q_SMOOTH). Correct for
  //    dual-band embeds; misclassified borderline blocks cost votes, never
  //    a desync (positional bit assignment).
  // 3. 'full'     - all blocks at Q (legacy full-coverage embeds).
  return decodeAttempt('textured') || decodeAttempt('dual') || decodeAttempt('full')

  function decodeAttempt(strategy) {
    const softVotes = new Float64Array(bitLength) // + = bit-0 evidence, − = bit-1
    const block = new Float32Array(64)

    for (let by = 0; by < blocksY; by++) {
      for (let bx = 0; bx < blocksX; bx++) {
        let q = Q
        if (strategy === 'textured') {
          if (blockStddev(Y, width, bx, by) < TEXTURE_DECODE_STDDEV) continue
        } else if (strategy === 'dual') {
          // classify like the embedder (same threshold); borderline flips
          // contribute noise votes that the redundancy absorbs
          q = blockStddev(Y, width, bx, by) >= TEXTURE_EMBED_STDDEV ? Q : Q_SMOOTH
        }
        for (let x = 0; x < 8; x++)
          for (let y = 0; y < 8; y++)
            block[x * 8 + y] = Y[((by * 8 + x) * width) + (bx * 8 + y)]

        const dct = dct2d(block)
        const c = dct[2 * 8 + 1]

        // True soft-decision: distance to nearest even vs odd q-spaced level.
        const nearEven = 2 * Math.round(c / (2 * q)) * q               // nearest even-parity level
        const nearOdd  = (2 * Math.round((c - q) / (2 * q)) + 1) * q   // nearest odd-parity level
        const dE = Math.abs(c - nearEven)
        const dO = Math.abs(c - nearOdd)
        softVotes[(by * blocksX + bx) % bitLength] += (dO - dE)
      }
    }

    // 1. Bit decisions from accumulated soft votes
    const bits = Array.from(softVotes, v => v < 0 ? 1 : 0)

    // 2. Verify sync tag
    let sync = 0
    for (let i = 0; i < 16; i++) sync = (sync << 1) | bits[i]
    if (sync !== SYNC_TAG) return null

    // 3. Reconstruct RS-coded bytes
    const rsCoded = new Array(rsByteLen)
    for (let i = 0; i < rsByteLen; i++) {
      let v = 0
      for (let b = 0; b < 8; b++) v = (v << 1) | bits[16 + i * 8 + b]
      rsCoded[i] = v
    }

    // 4. RS decode (corrects up to 2 byte errors) - never surface a wrong value
    const decoded = rsDecode(rsCoded, RS_NSYM)
    if (!decoded) return null

    // 5. Verify CRC over the payload bytes
    const payload = decoded.slice(0, payloadByteLength)
    const extractedCRC = (decoded[payloadByteLength] << 8) | decoded[payloadByteLength + 1]
    if (extractedCRC !== crc16(payload)) return null

    return payload
  }
}

/**
 * Selects what T1 carries, per spec §4.5.1 (normative). Returns a fixed-capacity
 * NUL-padded payload Buffer + the payloadMode, or null to SKIP T1.
 *
 * Precedence: primary:true → first reading-order intent:'actionable' → skip.
 * Capacity rule - NEVER truncate: if the value fits, embed it verbatim (`direct`);
 * if not, embed contentId (`id`) for T2 to resolve. A clipped value is a wrong
 * value and a conformance failure, so we refuse it.
 *
 * @param {Array}  textLayer
 * @param {string} [contentId]
 * @returns {{ payload: Buffer, payloadMode: 'direct'|'id' } | null}
 */
function selectT1Payload(textLayer, contentId) {
  const layer = Array.isArray(textLayer) ? textLayer : []

  // §4.5.1 precedence - primary first, then first actionable in reading order.
  const primaries = layer.filter(o => o && o.primary === true)
  let chosen = primaries[0]
  if (primaries.length > 1) {
    // At most one primary; use the first, warn (spec §4.5.1 / §8).
    console.warn('[siml] multiple primary:true objects; using the first in order')
  }
  if (!chosen) {
    chosen = layer.find(o => o && (o.intent || 'actionable') === 'actionable' &&
      ['phone', 'email', 'url', 'address'].includes(o.type))
  }
  if (!chosen) return null // nothing to carry → skip T1

  const fits = (str) => Buffer.byteLength(str, 'utf8') <= T1_CAPACITY

  if (fits(chosen.text)) {
    const buf = Buffer.alloc(T1_CAPACITY) // NUL-padded, never sliced
    buf.write(chosen.text, 'utf8')
    return { payload: buf, payloadMode: 'direct' }
  }
  // Value overflows capacity → carry the contentId (id mode), never a clipped value.
  if (contentId && fits(contentId)) {
    const buf = Buffer.alloc(T1_CAPACITY)
    buf.write(contentId, 'utf8')
    return { payload: buf, payloadMode: 'id' }
  }
  // The selected field cannot be carried at all (long primary + no usable id):
  // fall through to the first actionable field that FITS before giving up -
  // carrying the phone beats carrying nothing. Never truncate.
  const fallback = layer.find(o => o && o !== chosen &&
    (o.intent || 'actionable') === 'actionable' &&
    ['phone', 'email', 'url', 'address'].includes(o.type) && fits(o.text))
  if (fallback) {
    const buf = Buffer.alloc(T1_CAPACITY)
    buf.write(fallback.text, 'utf8')
    return { payload: buf, payloadMode: 'direct' }
  }
  // Nothing carriable → skip T1 (T0/T2 still apply).
  return null
}

module.exports = {
  embedWatermark,
  extractWatermark,
  selectT1Payload,
  crc16,
  CANONICAL_WIDTH,
  SYNC_TAG,
  RS_NSYM,
  T1_CAPACITY
}
