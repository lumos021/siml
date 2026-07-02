// src/embed-jpeg.js - JPEG APP11 JUMBF Box Inserter
//
// The JP02 + segment-index APP11 framing here is the ONE canonical JUMBF-in-JPEG
// framing for SIML (spec/INTEGRATION). Both write() and preserve() produce JPEG
// layers through buildApp11Segment() so a third-party reader sees identical bytes
// regardless of how the layer got there. Do not hand-roll a second framing.
const fs = require('fs')
const { serializeJUMBF } = require('./jumbf')

const MARKER_SOS = 0xFFDA
const JP02_SIGNATURE = Buffer.from([0x4A, 0x50, 0x30, 0x32]) // "JP02"

/**
 * Wrap raw JUMBF superbox bytes in the canonical APP11 framing:
 *   FF EB [2-byte size] [JP02] [segment index = 1] [JUMBF superbox]
 *
 * @param {Buffer} jumbfBytes  a serialized JUMBF superbox (NOT a payload object)
 * @returns {Buffer} the complete APP11 segment
 */
function buildApp11Segment(jumbfBytes) {
  const segmentLength = 2 + JP02_SIGNATURE.length + 4 + jumbfBytes.length // size + JP02 + index + payload

  // JPEG marker-segment length is a single 16-bit field. A payload that overflows
  // it would wrap and silently corrupt the file. Multi-segment APP11 packetization
  // is out of scope here, so fail loud instead (spec fail-loud rule, §4.6).
  if (segmentLength > 0xFFFF) {
    throw Object.assign(
      new Error(`SIML payload too large for a single JPEG APP11 segment (${segmentLength} > 65535 bytes)`),
      { code: 'SIML_E_004' }
    )
  }

  const header = Buffer.alloc(12)
  header[0] = 0xFF
  header[1] = 0xEB // APP11 marker
  header.writeUInt16BE(segmentLength, 2)
  JP02_SIGNATURE.copy(header, 4)
  header.writeUInt32BE(1, 8) // Segment index 1 (single-packet)

  return Buffer.concat([header, jumbfBytes])
}

/**
 * Splice an APP11 segment into a JPEG buffer right before SOS (FF DA).
 *
 * @param {Buffer} input    a JPEG buffer (validated SOI)
 * @param {Buffer} segment  an APP11 segment from buildApp11Segment()
 * @returns {Buffer} the JPEG with the segment inserted
 */
function insertApp11(input, segment) {
  if (input[0] !== 0xFF || input[1] !== 0xD8) throw new Error('Not a valid JPEG file')

  let pos = 2
  let insertAt = -1
  while (pos < input.length - 1) {
    if (input[pos] !== 0xFF) throw new Error('Malformed JPEG at offset ' + pos)
    const marker = (input[pos] << 8) | input[pos + 1]
    if (marker === MARKER_SOS) { insertAt = pos; break }
    if (pos + 4 > input.length) break
    const segLen = input.readUInt16BE(pos + 2)
    pos += 2 + segLen
  }
  if (insertAt === -1) throw new Error('JPEG missing SOS marker')

  return Buffer.concat([input.slice(0, insertAt), segment, input.slice(insertAt)])
}

/**
 * Injects a JUMBF superbox containing SIML payload into a JPEG APP11 segment.
 *
 * @param {string} inputPath
 * @param {Object} payload
 * @param {string} outputPath
 * @returns {number} Output file size
 */
function embedSIML(inputPath, payload, outputPath) {
  const input = fs.readFileSync(inputPath)
  const segment = buildApp11Segment(serializeJUMBF(payload))
  const output = insertApp11(input, segment)
  fs.writeFileSync(outputPath, output)
  return output.length
}

module.exports = { embedSIML, buildApp11Segment, insertApp11 }
