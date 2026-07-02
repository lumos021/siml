// src/jumbf.js - Pure JavaScript JUMBF Box (ISO/IEC 19566-5) Encoder/Decoder

const SIML_UUID = Buffer.from('de6062e1-9e7b-494e-94b3-db6fcc257fdc'.replace(/-/g, ''), 'hex')
const TYPE_JUMB = Buffer.from('jumb', 'ascii')
const TYPE_JUMBD = Buffer.from('jumbd', 'ascii')
const TYPE_JSON = Buffer.from('json', 'ascii')

// Decompression-bomb cap (spec §10): refuse payloads whose
// JSON content box exceeds this size rather than parsing unbounded input.
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024 // ~4 MiB

/**
 * Creates a JUMBF superbox containing the SIML JSON payload.
 *
 * @param {Object} jsonObject
 * @returns {Buffer} JUMBF Superbox bytes
 */
function serializeJUMBF(jsonObject) {
  const jsonStr = JSON.stringify(jsonObject)
  const payloadBytes = Buffer.from(jsonStr, 'utf8')

  // 1. Build JUMBF Description Box (jumbd)
  const label = 'siml\0' // null-terminated
  const jumbdLength = 4 + 4 + 16 + 1 + label.length // 25 + label length = 30 bytes
  const jumbd = Buffer.alloc(jumbdLength)
  
  jumbd.writeUInt32BE(jumbdLength, 0)
  TYPE_JUMBD.copy(jumbd, 4)
  SIML_UUID.copy(jumbd, 8)
  jumbd[24] = 0x03 // Flags: Requestable (0x01) | Label Present (0x02)
  jumbd.write(label, 25, 'ascii')

  // 2. Build Content Box (json)
  const jsonBoxLength = 4 + 4 + payloadBytes.length
  const jsonBox = Buffer.alloc(8 + payloadBytes.length)
  jsonBox.writeUInt32BE(jsonBoxLength, 0)
  TYPE_JSON.copy(jsonBox, 4)
  payloadBytes.copy(jsonBox, 8)

  // 3. Build JUMBF Superbox (jumb)
  const superboxLength = 4 + 4 + jumbd.length + jsonBox.length
  const superbox = Buffer.alloc(8)
  superbox.writeUInt32BE(superboxLength, 0)
  TYPE_JUMB.copy(superbox, 4)

  return Buffer.concat([superbox, jumbd, jsonBox])
}

/**
 * Extracts and parses JSON payload from a JUMBF superbox Buffer.
 *
 * @param {Buffer} buffer
 * @returns {Object|null} Parsed JSON payload
 */
function deserializeJUMBF(buffer) {
  try {
    if (buffer.length < 8) return null
    const superLength = buffer.readUInt32BE(0)
    const superType = buffer.slice(4, 8).toString('ascii')
    
    if (superType !== 'jumb') return null

    let pos = 8
    let payload = null

    while (pos < superLength && pos < buffer.length) {
      if (pos + 8 > buffer.length) break
      const boxLength = buffer.readUInt32BE(pos)
      const boxType = buffer.slice(pos + 4, pos + 8).toString('ascii')

      if (boxType === 'jumbd') {
        // Verify SIML Content Type UUID at offset pos + 8
        const uuid = buffer.slice(pos + 8, pos + 24)
        if (!uuid.equals(SIML_UUID)) {
          return null // Not a SIML JUMBF box
        }
      } else if (boxType === 'json') {
        if (boxLength - 8 > MAX_PAYLOAD_BYTES) return null // oversized → skip
        const jsonBytes = buffer.slice(pos + 8, pos + boxLength)
        payload = JSON.parse(jsonBytes.toString('utf8'))
      }
      
      pos += boxLength
    }
    return payload
  } catch (e) {
    return null
  }
}

module.exports = {
  serializeJUMBF,
  deserializeJUMBF,
  SIML_UUID
}
