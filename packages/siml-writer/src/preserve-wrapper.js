// src/preserve-wrapper.js - package wrapper around the verified preserve.js drop.
//
// CANONICAL FRAMING (drift #6, resolved): JP02 + segment-index is the one true
// JUMBF-in-JPEG framing (spec/INTEGRATION). The bundled preserve.js is byte-
// faithful to the Python reference and stays unedited, but its JPEG WRITE path
// uses a bare-UUID-first shortcut that nothing else parses. So we do NOT use
// preserve()'s JPEG output path: when the OUTPUT is JPEG we re-frame the raw SIML
// payload through the writer's own buildApp11Segment()/insertApp11() - the same
// function write() uses - so preserved JPEG bytes are identical to authored ones,
// for any source format (PNG/WebP/JPEG → JPEG). PNG/WebP outputs already match,
// so preserve()'s port handles those unchanged.

const preserve = require('./preserve')
const { buildApp11Segment, insertApp11 } = require('./embed-jpeg')

const SIML_UUID = preserve.SIML_UUID
const JP02 = Buffer.from([0x4A, 0x50, 0x30, 0x32])

// Lazy require of the reader extractor (sibling package) so this stays usable
// even if the reader isn't installed - we simply skip verification then.
function getExtractor() {
  try { return require('../../siml-reader/src/extract').extractPayload }
  catch { return null }
}

async function readerCanParse(buf) {
  const extract = getExtractor()
  if (!extract) return true // can't verify → trust the canonical-framing path
  try {
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const r = await extract(ab)
    return !!(r && r.payload && Array.isArray(r.payload.textLayer))
  } catch { return false }
}

// Extract the raw JUMBF superbox from the source, whatever its carrier.
//   PNG/WebP: the chunk data IS the JUMBF superbox (readPayload returns it).
//   JPEG: strip the canonical JP02+index framing (2 marker + 2 len + 4 JP02 +
//         4 index = 12 bytes) to recover the superbox. Falls back to locating
//         'jumb' after the UUID for the legacy bare-UUID framing.
function extractJumbf(source) {
  const fmt = preserve.detectFormat(source) // throws on unknown
  if (fmt !== 'jpeg') {
    return preserve.readPayload(source) // PNG/WebP chunk data == superbox
  }
  // JPEG: find the APP11 segment carrying the SIML UUID.
  let i = 2
  while (i + 1 < source.length) {
    if (source[i] !== 0xff) { i += 1; continue }
    const m = source[i + 1]
    if (m === 0xd8 || m === 0xd9 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }
    if (m === 0xda) break
    if (i + 4 > source.length) break
    const ln = source.readUInt16BE(i + 2)
    if (ln < 2 || i + 2 + ln > source.length) break
    const seg = source.subarray(i, i + 2 + ln)
    if (m === 0xeb && seg.includes(SIML_UUID)) {
      // Canonical framing: superbox begins right after JP02(4)+index(4) = offset 12.
      if (seg.length >= 12 && seg.subarray(4, 8).equals(JP02)) return seg.subarray(12)
      // Legacy bare-UUID framing: superbox begins at the 'jumb' box after the UUID.
      const jumbIdx = seg.indexOf(Buffer.from('jumb'))
      if (jumbIdx >= 4) return seg.subarray(jumbIdx - 4) // include the 4-byte box length
      return null
    }
    i += 2 + ln
  }
  return null
}

/**
 * Copy the SIML layer from `source` onto a re-encoded `output`, in the canonical
 * framing, guaranteeing the result is reader-parseable (or returning `output`
 * unchanged). A SIML failure must never break the host pipeline.
 *
 * @param {Buffer|Uint8Array} source  original image carrying the SIML layer
 * @param {Buffer|Uint8Array} output  re-encoded image (layer stripped)
 * @returns {Promise<Buffer>}
 */
async function preserveLayer(source, output) {
  source = Buffer.isBuffer(source) ? source : Buffer.from(source)
  output = Buffer.isBuffer(output) ? output : Buffer.from(output)

  let outFmt
  try { outFmt = preserve.detectFormat(output) } catch { return output } // unknown out → pass through
  if (!preserve.hasLayer(source)) return output                          // nothing to copy
  try { if (preserve.hasLayer(output)) return output } catch { return output } // no duplicate

  let result
  if (outFmt === 'jpeg') {
    // Re-frame through the writer's canonical JPEG framing.
    try {
      const jumbf = extractJumbf(source)
      if (!jumbf) return output
      result = insertApp11(output, buildApp11Segment(jumbf))
    } catch { return output }
  } else {
    // PNG/WebP: preserve()'s port already produces matching framing.
    result = preserve.preserve(source, output)
  }

  if (result === output) return output
  return (await readerCanParse(result)) ? result : output // never emit a corrupt layer
}

module.exports = { preserveLayer, preserve: preserve.preserve, hasLayer: preserve.hasLayer, extractJumbf }
