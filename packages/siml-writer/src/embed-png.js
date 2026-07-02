// src/embed-png.js - PNG siMl Chunk Injection containing JUMBF box
const fs = require('fs')
const { serializeJUMBF } = require('./jumbf')

const PNG_MAGIC = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A])
const CHUNK_IEND = Buffer.from('IEND', 'ascii')

function crc32(buf) {
  const table = makeCRC32Table()
  let crc = 0xFFFFFFFF
  for (const byte of buf) crc = (table[(crc ^ byte) & 0xFF] ^ (crc >>> 8))
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function makeCRC32Table() {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
}

function buildChunk(typeStr, data) {
  const type = Buffer.from(typeStr, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crcData = Buffer.concat([type, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(crcData), 0)
  return Buffer.concat([len, type, data, crc])
}

function embedSIML(inputPath, payload, outputPath) {
  const input = fs.readFileSync(inputPath)

  if (!input.slice(0, 8).equals(PNG_MAGIC))
    throw new Error('Not a valid PNG file')

  // Find the offset of the IEND chunk
  let pos = 8
  let iendOffset = -1
  while (pos < input.length) {
    if (pos + 8 > input.length) break
    const len = input.readUInt32BE(pos)
    const type = input.slice(pos + 4, pos + 8)
    if (type.equals(CHUNK_IEND)) { iendOffset = pos; break }
    pos += 12 + len
  }
  if (iendOffset === -1) throw new Error('PNG missing IEND chunk')

  // Serialize SIML JSON as JUMBF box
  const jumbfBytes = serializeJUMBF(payload)

  // Build siMl chunk containing standard JUMBF superbox
  const simlChunk = buildChunk('siMl', jumbfBytes)

  // Splice: everything up to IEND + siMl + IEND onwards
  const before = input.slice(0, iendOffset)
  const iendAndAfter = input.slice(iendOffset)
  const output = Buffer.concat([before, simlChunk, iendAndAfter])

  fs.writeFileSync(outputPath, output)
  return output.length
}

module.exports = { embedSIML }
