// src/fingerprint.js - 256-bit Perceptual Hash (pHash, DCT-based)
//
// Spec §5.2 specifies a DCT perceptual hash. We resize to 32×32 luminance, take
// the 2-D DCT, keep the low-frequency 16×16 block (excluding the DC term's bias
// by thresholding against the median of that block), and emit 256 bits. This is
// markedly more robust to recompression/downscale than a difference hash, which
// is what the §5.3 reference distances assume.

const PH_SIZE = 32      // DCT input grid
const PH_LOW = 16       // low-frequency block side -> 16*16 = 256 bits

// Precompute the 1-D DCT-II basis for a length-PH_SIZE signal.
const dctBasis = (() => {
  const basis = new Float64Array(PH_SIZE * PH_SIZE)
  for (let u = 0; u < PH_SIZE; u++) {
    for (let x = 0; x < PH_SIZE; x++) {
      basis[u * PH_SIZE + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * PH_SIZE))
    }
  }
  return basis
})()

/**
 * Computes a 256-bit pHash from a 32×32 greyscale pixel buffer (1024 bytes).
 *
 * @param {Uint8Array} greyscale32x32 - 32×32 greyscale pixels (1024 bytes)
 * @returns {Buffer} 32-byte (256-bit) perceptual hash
 */
function calculatePHashFromGreyscale(greyscale32x32) {
  if (greyscale32x32.length !== PH_SIZE * PH_SIZE) {
    throw new Error(`Expected ${PH_SIZE}x${PH_SIZE} greyscale buffer (${PH_SIZE * PH_SIZE} bytes)`)
  }

  // Row pass then column pass (separable 2-D DCT-II).
  const rows = new Float64Array(PH_SIZE * PH_SIZE)
  for (let y = 0; y < PH_SIZE; y++) {
    for (let u = 0; u < PH_SIZE; u++) {
      let sum = 0
      for (let x = 0; x < PH_SIZE; x++) {
        sum += greyscale32x32[y * PH_SIZE + x] * dctBasis[u * PH_SIZE + x]
      }
      rows[y * PH_SIZE + u] = sum
    }
  }
  const dct = new Float64Array(PH_SIZE * PH_SIZE)
  for (let u = 0; u < PH_SIZE; u++) {
    for (let v = 0; v < PH_SIZE; v++) {
      let sum = 0
      for (let y = 0; y < PH_SIZE; y++) {
        sum += rows[y * PH_SIZE + v] * dctBasis[u * PH_SIZE + y]
      }
      dct[u * PH_SIZE + v] = sum
    }
  }

  // Collect the low-frequency PH_LOW×PH_LOW block, excluding the (0,0) DC term
  // from the median so overall brightness doesn't dominate the threshold.
  const coeffs = new Float64Array(PH_LOW * PH_LOW)
  let k = 0
  for (let u = 0; u < PH_LOW; u++) {
    for (let v = 0; v < PH_LOW; v++) {
      coeffs[k++] = dct[u * PH_SIZE + v]
    }
  }
  const sortedNoDC = Array.from(coeffs).slice(1).sort((a, b) => a - b)
  const median = sortedNoDC[Math.floor(sortedNoDC.length / 2)]

  const hash = Buffer.alloc(32)
  for (let i = 0; i < PH_LOW * PH_LOW; i++) {
    if (coeffs[i] > median) {
      hash[i >> 3] |= (1 << (7 - (i & 7)))
    }
  }
  return hash
}

/**
 * Calculates Hamming distance between two 32-byte hashes.
 *
 * @param {Buffer|Uint8Array} hash1
 * @param {Buffer|Uint8Array} hash2
 * @returns {number} Hamming distance (0 to 256)
 */
function hammingDistance(hash1, hash2) {
  let distance = 0
  for (let i = 0; i < 32; i++) {
    let xor = hash1[i] ^ hash2[i]
    while (xor > 0) {
      if (xor & 1) distance++
      xor >>>= 1
    }
  }
  return distance
}

// T2 match threshold on the 256-bit hash. Ratified ≤ 24 on real images (spec
// §5.3): legit matches sit well under it while distinct images sit ≥ 35 - the
// margin is pinned by C-T2 in the conformance suite. Above it → no match.
const MATCH_THRESHOLD = 24

// Staleness threshold for pixelDigest (spec §9.3). The digest is a pHash of the
// canonicalized luminance; "fresh" = recomputed digest within this Hamming
// distance of the stored one. It must survive the re-encode/downscale band T1
// survives (so a CDN transcode stays fresh) yet flip on a real content edit.
// Tuned against the same real-image margin as T2 and pinned in C-STALE.
const STALE_THRESHOLD = 10

// Region hash (spec §5.3.1). A pHash of ONLY the distinguishing region - the
// primary/actionable field's `bounds` - so near-duplicate template images that
// share 95% of their pixels are told apart by the 5% that differs (the number).
// Same 256-bit pHash on a 32×32 crop of the region; a SEPARATE (looser) threshold
// because a small text strip carries less structure than a whole image.
const REGION_MATCH_THRESHOLD = 40

// Pick the region to fingerprint: the primary field, else the first actionable
// field, else the first selectable object. Returns its %-bounds or null.
function selectRegionBounds(textLayer) {
  const layer = Array.isArray(textLayer) ? textLayer : []
  const actionable = new Set(['phone', 'email', 'url', 'address'])
  const chosen =
    layer.find(o => o && o.primary === true) ||
    layer.find(o => o && actionable.has(o.type) && (o.intent || 'actionable') !== 'readonly') ||
    layer.find(o => o && o.selectable !== false)
  return chosen && chosen.bounds ? chosen.bounds : null
}

module.exports = {
  calculatePHashFromGreyscale,
  hammingDistance,
  MATCH_THRESHOLD,
  STALE_THRESHOLD,
  REGION_MATCH_THRESHOLD,
  selectRegionBounds,
  PH_SIZE,
}
