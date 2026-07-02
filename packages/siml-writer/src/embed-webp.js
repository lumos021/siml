// src/embed-webp.js - WebP siML Chunk Injection containing JUMBF box
const fs = require('fs')
const sharp = require('sharp')
const { serializeJUMBF } = require('./jumbf')

const FCC = s => Buffer.from(s, 'ascii')  // FourCC helper

function readUInt32LE(buf, offset) { return buf.readUInt32LE(offset) }
function writeUInt32LE(buf, val, offset) { buf.writeUInt32LE(val, offset) }

function buildRIFFChunk(fourcc, data) {
  const header = Buffer.alloc(8)
  FCC(fourcc).copy(header, 0)
  writeUInt32LE(header, data.length, 4)
  // RIFF chunks are padded to even length
  const pad = data.length % 2 === 1 ? Buffer.from([0x00]) : Buffer.alloc(0)
  return Buffer.concat([header, data, pad])
}

async function embedSIML(inputPath, payload, outputPath) {
  const input = fs.readFileSync(inputPath)

  // Verify WebP header
  if (!input.slice(0, 4).equals(FCC('RIFF')) ||
      !input.slice(8, 12).equals(FCC('WEBP')))
    throw new Error('Not a valid WebP file')

  const jumbfBytes = serializeJUMBF(payload)
  const simlData = buildRIFFChunk('siML', jumbfBytes)

  // Determine WebP subtype from the first chunk after WEBP
  const firstFourCC = input.slice(12, 16).toString('ascii')

  let outputBody

  if (firstFourCC === 'VP8X') {
    // Already Extended - append siML before end-of-file
    // Find the end of all existing chunks
    const body = input.slice(12) // everything after "WEBP"
    outputBody = Buffer.concat([body, simlData])

  } else {
    // Simple VP8 or VP8L - convert to Extended format
    const meta = await sharp(inputPath).metadata()
    const { width, height } = meta
    
    if (!width || !height) throw new Error('Could not read WebP image dimensions')

    // Build VP8X chunk (10 bytes of data)
    const vp8xData = Buffer.alloc(10, 0)
    // flags: no ICC, no alpha, no EXIF, no XMP, no animation = 0x00000000
    writeUInt32LE(vp8xData, 0, 0)
    // Canvas Width Minus One (24-bit LE)
    vp8xData[4] = (width - 1) & 0xFF
    vp8xData[5] = ((width - 1) >> 8) & 0xFF
    vp8xData[6] = ((width - 1) >> 16) & 0xFF
    // Canvas Height Minus One (24-bit LE)
    vp8xData[7] = (height - 1) & 0xFF
    vp8xData[8] = ((height - 1) >> 8) & 0xFF
    vp8xData[9] = ((height - 1) >> 16) & 0xFF

    const vp8xChunk = buildRIFFChunk('VP8X', vp8xData)

    // Original image chunk (VP8 or VP8L) - preserve verbatim
    const origChunkSize = readUInt32LE(input, 16)
    const origChunk = input.slice(12, 16 + 4 + origChunkSize + (origChunkSize % 2))

    outputBody = Buffer.concat([vp8xChunk, origChunk, simlData])
  }

  // Rebuild RIFF header with updated file size
  const riffHeader = Buffer.alloc(12)
  FCC('RIFF').copy(riffHeader, 0)
  writeUInt32LE(riffHeader, outputBody.length + 4, 4) // +4 for 'WEBP' FourCC
  FCC('WEBP').copy(riffHeader, 8)

  const output = Buffer.concat([riffHeader, outputBody])
  fs.writeFileSync(outputPath, output)
  return output.length
}

module.exports = { embedSIML }
