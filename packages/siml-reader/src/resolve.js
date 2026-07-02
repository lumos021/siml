// src/resolve.js - the full SIML reader resolution order (spec §6): T0 → T1 → T2
// → OCR/visible-text fallback. This is the library home for the pipeline that
// previously lived only in the demo viewer (PROJECTSTATE drift #3).
//
// Each tier's integrity gate is honored: T0 JUMBF parse, T1 CRC (inside
// getWatermarkFromImageElement), T2 a Hamming-distance threshold here. The
// resolver never throws and never returns a confidently-wrong value - a tier that
// can't verify is skipped, and if all miss the caller shows the plain raster.

const {
  extractPayload, getWatermarkFromImageElement,
  getPHashFromImageElement, getRegionHashFromImageElement,
} = require('./extract')

const T2_MATCH_THRESHOLD = 24      // spec §5.3, whole-image pHash
const STALE_THRESHOLD = 10         // spec §9.3 pixelDigest tolerance (must match writer)
const REGION_MATCH_THRESHOLD = 40  // spec §5.3.1, region pHash veto (must match writer)

function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity
  let dist = 0
  for (let i = 0; i < a.length; i += 2) {
    let xor = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16)
    while (xor > 0) { if (xor & 1) dist++; xor >>>= 1 }
  }
  return dist
}

// Staleness check (spec §9.3): does the layer's stored pixelDigest still match the
// delivered pixels? Returns true (stale) only when we have BOTH a stored digest
// and a recomputed one that diverge past tolerance. If either is missing we cannot
// judge, so we do NOT mark stale (older layers without a digest skip detection).
function isStale(payload, imageEl) {
  const stored = payload && payload.pixelDigest
  if (!stored || !imageEl) return false
  let live = null
  try { live = getPHashFromImageElement(imageEl) } catch { return false }
  if (!live) return false
  return hammingHex(stored, live) > STALE_THRESHOLD
}

// §5.3.1 step 1 - CANDIDATE SET, not single nearest. Returns ALL entries within
// threshold, sorted nearest-first. On near-duplicate template imagery several
// entries land inside threshold; picking the single nearest by whole-image
// distance would return a confident WRONG number (the number is the discarded 5%).
function fingerprintCandidates(dhash, registry, threshold = T2_MATCH_THRESHOLD) {
  if (!dhash || !registry) return []
  const out = []
  for (const key of Object.keys(registry)) {
    const dist = hammingHex(dhash, key)
    if (dist <= threshold) out.push({ key, dist, entry: registry[key] })
  }
  return out.sort((a, b) => a.dist - b.dist)
}

// Back-compat single-nearest (still exported for callers that don't verify), but
// resolveLayer no longer uses it for surfacing - verification is mandatory.
function resolveFingerprint(dhash, registry, threshold = T2_MATCH_THRESHOLD) {
  const c = fingerprintCandidates(dhash, registry, threshold)
  return c.length ? { entry: c[0].entry, dist: c[0].dist } : null
}

// §5.3.1 steps 2+3 - VERIFY a candidate set against the query image's own pixels.
// (2 SHOULD) region disambiguation: among candidates, pick the one whose stored
// regionHash is closest to the query's region pixels. (3 MUST) pixel veto: accept
// ONLY if that region distance is within REGION_MATCH_THRESHOLD; otherwise reject
// (fail-loud) rather than surface a guess. An optional `ocrVerify(entry, imageEl)`
// hook can add a stronger character-level veto; if it returns false we also reject.
//
// Degenerate case: exactly one candidate AND it carries no regionHash → we cannot
// verify by region. We only trust it if it is an *unambiguous, tight* whole-image
// match (dist very small); otherwise reject. This keeps legacy single-image
// registries working while refusing to guess on anything that looks near-dup.
function verifyT2(candidates, imageEl, ocrVerify) {
  if (!candidates.length) return null

  const withRegion = candidates.filter(c => c.entry && c.entry.regionHash && c.entry.regionBounds)

  if (withRegion.length && imageEl) {
    let best = null
    for (const c of withRegion) {
      const live = getRegionHashFromImageElement(imageEl, c.entry.regionBounds)
      if (!live) continue
      const rdist = hammingHex(c.entry.regionHash, live)
      if (best === null || rdist < best.rdist) best = { ...c, rdist }
    }
    if (!best) return null                          // region unreadable → reject
    if (best.rdist > REGION_MATCH_THRESHOLD) return null // no candidate consistent → reject
    // Ambiguity guard: if a *second* candidate's region is essentially as close,
    // we cannot safely disambiguate → reject rather than coin-flip.
    const rivals = withRegion
      .map(c => ({ c, rdist: hammingHex(c.entry.regionHash, getRegionHashFromImageElement(imageEl, c.entry.regionBounds) || '') }))
      .filter(r => r.c.key !== best.key && Number.isFinite(r.rdist))
    const tooClose = rivals.some(r => r.rdist <= best.rdist + 4)
    if (tooClose) return null
    if (typeof ocrVerify === 'function' && !ocrVerify(best.entry, imageEl)) return null
    return { entry: best.entry, dist: best.dist, regionDist: best.rdist }
  }

  // No region hashes available. Only trust a single, tight, unambiguous match.
  if (candidates.length === 1 && candidates[0].dist <= 6) {
    const only = candidates[0]
    if (typeof ocrVerify === 'function' && !ocrVerify(only.entry, imageEl)) return null
    return { entry: only.entry, dist: only.dist, regionDist: null }
  }
  return null // ambiguous or unverifiable → reject (fail-loud)
}

/**
 * Resolve a SIML layer from image bytes, following the spec §6 tier order.
 *
 * @param {ArrayBuffer} buffer        the raw image bytes
 * @param {Object} [opts]
 * @param {HTMLImageElement} [opts.imageEl]   a loaded <img> of the same bytes,
 *        required for the pixel-based T1/T2 tiers (canvas needs an element).
 * @param {(dhash:string)=>(object|null|Promise)} [opts.lookup]  T2 registry
 *        resolver: given a pHash hex, return the full payload (or null). If a
 *        plain object is given via opts.registry, a built-in threshold lookup is used.
 * @param {object} [opts.registry]    plain { hashHex: payload } map (alternative to lookup)
 * @returns {Promise<{ tier:'T0'|'T1'|'T2', payload:object, imageBytes?, imageMime? }|null>}
 */
async function resolveLayer(buffer, opts = {}) {
  const { imageEl, lookup, registry } = opts

  // T0 - JUMBF container (richest, lossless)
  try {
    const t0 = await extractPayload(buffer)
    if (t0 && t0.payload) {
      // Staleness (spec §9.3): if the layer's pixelDigest no longer matches the
      // delivered pixels, the container was copied onto edited pixels. Mark STALE
      // so the caller suppresses actions and doesn't present text as authoritative.
      const stale = isStale(t0.payload, imageEl)
      return { tier: 'T0', stale, ...t0 }
    }
  } catch { /* fall through */ }

  // T1 - pixel watermark (CRC-verified inside the extractor)
  if (imageEl) {
    let t1Text = null
    try { t1Text = getWatermarkFromImageElement(imageEl) } catch { /* skip */ }

    // §5.3.1 step 4 - contentId shortcut: if T1 recovered a contentId, resolve the
    // exact entry directly; no T2 guessing / verification needed.
    if (t1Text && registry) {
      for (const key of Object.keys(registry)) {
        if (registry[key] && registry[key].contentId === t1Text) {
          return { tier: 'T2', payload: registry[key], verified: 'contentId' }
        }
      }
    }

    // T2 - perceptual fingerprint → registry. A pHash match is a HYPOTHESIS: we
    // MUST verify against the query's own pixels before surfacing (spec §5.3.1),
    // or a near-duplicate template returns a confident wrong number.
    try {
      const dhash = getPHashFromImageElement(imageEl)
      if (typeof lookup === 'function') {
        // Custom resolver owns its own verification contract.
        const entry = await lookup(dhash, imageEl)
        if (entry) return { tier: 'T2', payload: entry }
      } else if (registry) {
        const candidates = fingerprintCandidates(dhash, registry)
        const verified = verifyT2(candidates, imageEl, opts.ocrVerify)
        if (verified) return { tier: 'T2', payload: verified.entry, verified: 'region' }
        // else: candidates existed but none verified → fall through (fail-loud).
      }
    } catch { /* skip */ }

    // T1 direct fallback - synthesize a minimal layer from the recovered field.
    if (t1Text) {
      return {
        tier: 'T1',
        payload: {
          siml: '0.3',
          contentId: 't1-resolved',
          textLayer: [{
            id: 't1', text: t1Text,
            type: t1Text.includes('@') ? 'email' : /^https?:|\./.test(t1Text) ? 'url' : 'phone',
            intent: 'actionable',
            bounds: { x: 10, y: 45, w: 80, h: 10 },
            selectable: true, label: 'Watermark recovery',
          }],
        },
      }
    }
  }

  // OCR / visible-text - the commodity floor. SIML adds no claim; caller shows raster.
  return null
}

module.exports = {
  resolveLayer, resolveFingerprint, fingerprintCandidates, verifyT2, hammingHex,
  T2_MATCH_THRESHOLD, REGION_MATCH_THRESHOLD,
}
