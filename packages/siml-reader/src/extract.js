// src/extract.js - SIML v0.3 Extractor & Resolution Order Pipeline
const SIML_UUID = new Uint8Array([
  0xDE, 0x60, 0x62, 0xE1, 0x9E, 0x7B, 0x49, 0x4E, 0x94, 0xB3, 0xDB, 0x6F, 0xCC, 0x25, 0x7F, 0xDC
])

const SYNC_TAG = 0xD4B3
const CANONICAL_WIDTH = 1024
const Q = 26
const RS_NSYM = 4
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024 // ~4 MiB decompression-bomb cap (spec §10)

// ─── GF(2˸8) Reed-Solomon (same primitive poly 0x11D as writer/rs.js) ────────
const RS_EXP = new Uint8Array(512)
const RS_LOG = new Uint8Array(256)
;(function () {
  let x = 1
  for (let i = 0; i < 255; i++) { RS_EXP[i] = x; RS_LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d }
  for (let i = 255; i < 512; i++) RS_EXP[i] = RS_EXP[i - 255]
})()
const rsMul = (a, b) => (a && b) ? RS_EXP[RS_LOG[a] + RS_LOG[b]] : 0
const rsInv = a => RS_EXP[255 - RS_LOG[a]]
const rsEvalBE = (p, x) => { let y = 0; for (const c of p) y = rsMul(y, x) ^ c; return y }
const rsPMulBE = (p, q) => {
  const r = new Array(p.length + q.length - 1).fill(0)
  for (let i = 0; i < p.length; i++) for (let j = 0; j < q.length; j++) r[i+j] ^= rsMul(p[i], q[j])
  return r
}
function rsDecodeInline (codeword, nsym) {
  try {
    const msg = Array.from(codeword), n = msg.length
    const synd = Array.from({ length: nsym }, (_, i) => rsEvalBE(msg, RS_EXP[i]))
    if (synd.every(s => !s)) return new Uint8Array(codeword.slice(0, -nsym))
    // Berlekamp-Massey
    let sigma = [1], B = [1], L = 0, b = 1
    for (let i = 0; i < nsym; i++) {
      let d = synd[i]
      for (let j = 1; j < sigma.length; j++) if (i-j >= 0) d ^= rsMul(sigma[j], synd[i-j])
      B = [0, ...B]
      if (!d) continue
      const c = rsMul(d, rsInv(b))
      const ns = [...sigma]; while (ns.length < B.length) ns.push(0)
      for (let j = 0; j < B.length; j++) ns[j] ^= rsMul(c, B[j])
      if (2*L <= i) { L = i+1-L; B = sigma; b = d }
      sigma = ns
    }
    const ne = sigma.length - 1
    if (!ne || ne*2 > nsym) return null
    // Chien search
    const errPos = []
    for (let k = 0; k < n; k++) {
      const xi = RS_EXP[(255-k)%255]; let v = 0, xp = 1
      for (const c of sigma) { v ^= rsMul(c, xp); xp = rsMul(xp, xi) }
      if (!v) errPos.push(k)
    }
    if (errPos.length !== ne) return null
    // Omega
    const omega = new Array(nsym).fill(0)
    for (let k = 0; k < nsym; k++)
      for (let j = 0; j <= k && j < sigma.length; j++) omega[k] ^= rsMul(synd[k-j], sigma[j])
    // Sigma derivative
    const sd = Array.from({ length: sigma.length - 1 }, (_, i) => i%2===0 ? sigma[i+1] : 0)
    // Forney
    const corr = [...msg]
    for (const k of errPos) {
      const Xk = RS_EXP[k], XkI = RS_EXP[(255-k)%255]
      let omV = 0, sdV = 0, xp = 1
      for (const c of omega) { omV ^= rsMul(c, xp); xp = rsMul(xp, XkI) }
      xp = 1; for (const c of sd) { sdV ^= rsMul(c, xp); xp = rsMul(xp, XkI) }
      if (!sdV) return null
      corr[k] ^= rsMul(Xk, rsMul(omV, rsInv(sdV)))
    }
    if (Array.from({ length: nsym }, (_, i) => rsEvalBE(corr, RS_EXP[i])).some(s => s)) return null
    return new Uint8Array(corr.slice(0, -nsym))
  } catch { return null }
}
// ─────────────────────────────────────────────────────────────────────────────

// Precompute DCT terms
const cosTable = new Float32Array(8 * 8)
for (let u = 0; u < 8; u++) {
  for (let x = 0; x < 8; x++) {
    cosTable[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16)
  }
}

function cCoeff(w) {
  return w === 0 ? 1 / Math.sqrt(2) : 1
}

// CRC-16/CCITT-FALSE - MUST match siml-writer/src/watermark.js crc16
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

function rgbToY(rgba, width, height) {
  const Y = new Float32Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4]
    const g = rgba[i * 4 + 1]
    const b = rgba[i * 4 + 2]
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b
  }
  return Y
}

function extractWatermark(rgba, width, height, payloadByteLength = 16) {
  try {
    const Y = rgbToY(rgba, width, height)
    const blocksX = Math.floor(width / 8)
    const blocksY = Math.floor(height / 8)

    const rsByteLen = payloadByteLength + 2 + RS_NSYM     // payload + CRC(2) + parity(RS_NSYM)
    const bitLength = 16 + rsByteLen * 8                  // sync(16) + RS-coded bits
    const softVotes = new Float64Array(bitLength)

    const block = new Float32Array(64)
    let bitIndex = 0

    for (let by = 0; by < blocksY; by++) {
      for (let bx = 0; bx < blocksX; bx++) {
        for (let x = 0; x < 8; x++)
          for (let y = 0; y < 8; y++)
            block[x * 8 + y] = Y[((by * 8 + x) * width) + (bx * 8 + y)]

        const dct = dct2d(block)
        const c = dct[2 * 8 + 1]
        // QIM levels every Q, bit in the level's parity (MUST match the writer
        // and the Python reference; Q/2-spaced levels halve the margin).
        const nearEven = 2 * Math.round(c / (2 * Q)) * Q
        const nearOdd  = (2 * Math.round((c - Q) / (2 * Q)) + 1) * Q
        softVotes[bitIndex % bitLength] += (Math.abs(c - nearOdd) - Math.abs(c - nearEven))
        bitIndex++
      }
    }

    const bits = Array.from(softVotes, v => v < 0 ? 1 : 0)
    let sync = 0
    for (let i = 0; i < 16; i++) sync = (sync << 1) | bits[i]
    if (sync !== SYNC_TAG) return null

    const rsCoded = new Array(rsByteLen)
    for (let i = 0; i < rsByteLen; i++) {
      let v = 0; for (let b = 0; b < 8; b++) v = (v << 1) | bits[16 + i*8 + b]
      rsCoded[i] = v
    }

    const decoded = rsDecodeInline(rsCoded, RS_NSYM)
    if (!decoded) return null

    const payload = decoded.slice(0, payloadByteLength)
    const extractedCRC = (decoded[payloadByteLength] << 8) | decoded[payloadByteLength + 1]
    if (extractedCRC !== crc16(payload)) return null

    return payload
  } catch (e) {
    return null
  }
}

function detectFormat(buffer) {
  const b = new Uint8Array(buffer)
  if (b[0]===0x89&&b[1]===0x50&&b[2]===0x4E&&b[3]===0x47) return 'png'
  if (b[0]===0xFF&&b[1]===0xD8) return 'jpeg'
  if (b[0]===0x52&&b[1]===0x49&&b[2]===0x46&&b[3]===0x46&&
      b[8]===0x57&&b[9]===0x45&&b[10]===0x42&&b[11]===0x50) return 'webp'
  return null
}

function parseJUMBF(buffer, byteOffset, length) {
  try {
    const bytes = new Uint8Array(buffer, byteOffset, length)
    const v = new DataView(buffer, byteOffset, length)
    
    if (bytes.length < 8) return null
    const superLength = v.getUint32(0, false)
    const superType = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7])
    if (superType !== 'jumb') return null

    let pos = 8
    let payload = null

    while (pos < superLength && pos < bytes.length) {
      if (pos + 8 > bytes.length) break
      const boxLength = v.getUint32(pos, false)
      const boxType = String.fromCharCode(bytes[pos+4], bytes[pos+5], bytes[pos+6], bytes[pos+7])

      if (boxType === 'jumbd') {
        const uuid = bytes.subarray(pos + 8, pos + 24)
        const match = SIML_UUID.every((b, i) => uuid[i] === b)
        if (!match) return null
      } else if (boxType === 'json') {
        if (boxLength - 8 > MAX_PAYLOAD_BYTES) return null // oversized → skip
        const dataBytes = bytes.subarray(pos + 8, pos + boxLength)
        const jsonStr = new TextDecoder('utf-8').decode(dataBytes)
        payload = JSON.parse(jsonStr)
      }
      pos += boxLength
    }
    return payload
  } catch (e) {
    return null
  }
}

// Returns { payload, imageBytes, imageMime } or null
async function extractPayload(buffer) {
  const format = detectFormat(buffer)
  if (!format) return null

  let payload = null
  switch (format) {
    case 'png':  payload = extractPNG(buffer); break
    case 'jpeg': payload = extractJPEG(buffer); break
    case 'webp': payload = extractWebP(buffer); break
  }

  if (payload) {
    const mime = format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp'
    return { payload, imageBytes: buffer, imageMime: mime }
  }
  return null
}

function extractPNG(buffer) {
  const v = new DataView(buffer)
  let pos = 8
  while (pos < buffer.byteLength) {
    if (pos + 8 > buffer.byteLength) break
    const len  = v.getUint32(pos, false)
    const type = String.fromCharCode(
      v.getUint8(pos+4), v.getUint8(pos+5),
      v.getUint8(pos+6), v.getUint8(pos+7))
    if (type === 'siMl') {
      return parseJUMBF(buffer, pos + 8, len)
    }
    if (type === 'IEND') break
    pos += 12 + len
  }
  return null
}

function extractJPEG(buffer) {
  const v = new DataView(buffer)
  const IDENT = [0x4A, 0x50, 0x30, 0x32] // "JP02"
  let pos = 2

  while (pos < buffer.byteLength - 1) {
    if (v.getUint8(pos) !== 0xFF) break
    const marker = v.getUint16(pos, false)
    if (marker === 0xFFDA) break

    if (pos + 4 > buffer.byteLength) break
    const segLen = v.getUint16(pos + 2, false)
    if (marker === 0xFFEB) { // APP11
      const match = IDENT.every((b, i) => v.getUint8(pos + 4 + i) === b)
      if (match) {
        return parseJUMBF(buffer, pos + 12, segLen - 10)
      }
    }
    pos += 2 + segLen
  }
  return null
}

function extractWebP(buffer) {
  const v = new DataView(buffer)
  let pos = 12
  while (pos < buffer.byteLength - 7) {
    const type = String.fromCharCode(
      v.getUint8(pos), v.getUint8(pos+1),
      v.getUint8(pos+2), v.getUint8(pos+3))
    const len = v.getUint32(pos + 4, true)
    if (type === 'siML') {
      return parseJUMBF(buffer, pos + 8, len)
    }
    pos += 8 + len + (len % 2)
  }
  return null
}

// ─── Browser-Only Canvas-Assisted Watermark/dHash Extractor ───

// 256-bit DCT pHash (spec §5.2) - MUST match siml-writer/src/fingerprint.js.
const PH_SIZE = 32
const PH_LOW = 16
const phDctBasis = (() => {
  const b = new Float64Array(PH_SIZE * PH_SIZE)
  for (let u = 0; u < PH_SIZE; u++)
    for (let x = 0; x < PH_SIZE; x++)
      b[u * PH_SIZE + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * PH_SIZE))
  return b
})()

function getPHashFromImageElement(img) {
  try {
    let srcWidth = img.naturalWidth || img.width || 1024
    let srcHeight = img.naturalHeight || img.height || 512

    let canvas = document.createElement('canvas')
    canvas.width = srcWidth
    canvas.height = srcHeight
    let ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, srcWidth, srcHeight)

    // Halve recursively to prevent sub-sampling aliasing
    while (srcWidth > 2 * PH_SIZE && srcHeight > 2 * PH_SIZE) {
      const nextWidth = Math.ceil(srcWidth / 2)
      const nextHeight = Math.ceil(srcHeight / 2)
      const nextCanvas = document.createElement('canvas')
      nextCanvas.width = nextWidth
      nextCanvas.height = nextHeight
      const nextCtx = nextCanvas.getContext('2d')
      if (!nextCtx) break
      nextCtx.imageSmoothingEnabled = true
      nextCtx.imageSmoothingQuality = 'high'
      nextCtx.drawImage(canvas, 0, 0, srcWidth, srcHeight, 0, 0, nextWidth, nextHeight)
      canvas = nextCanvas
      ctx = nextCtx
      srcWidth = nextWidth
      srcHeight = nextHeight
    }

    const finalCanvas = document.createElement('canvas')
    finalCanvas.width = PH_SIZE
    finalCanvas.height = PH_SIZE
    const finalCtx = finalCanvas.getContext('2d')
    if (!finalCtx) return null
    finalCtx.imageSmoothingEnabled = true
    finalCtx.imageSmoothingQuality = 'high'
    finalCtx.drawImage(canvas, 0, 0, srcWidth, srcHeight, 0, 0, PH_SIZE, PH_SIZE)

    const data = finalCtx.getImageData(0, 0, PH_SIZE, PH_SIZE).data

    const grey = new Float64Array(PH_SIZE * PH_SIZE)
    for (let i = 0; i < PH_SIZE * PH_SIZE; i++)
      grey[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]

    const rows = new Float64Array(PH_SIZE * PH_SIZE)
    for (let y = 0; y < PH_SIZE; y++)
      for (let u = 0; u < PH_SIZE; u++) {
        let sum = 0
        for (let x = 0; x < PH_SIZE; x++) sum += grey[y * PH_SIZE + x] * phDctBasis[u * PH_SIZE + x]
        rows[y * PH_SIZE + u] = sum
      }
    const dct = new Float64Array(PH_SIZE * PH_SIZE)
    for (let u = 0; u < PH_SIZE; u++)
      for (let v = 0; v < PH_SIZE; v++) {
        let sum = 0
        for (let y = 0; y < PH_SIZE; y++) sum += rows[y * PH_SIZE + v] * phDctBasis[u * PH_SIZE + y]
        dct[u * PH_SIZE + v] = sum
      }

    const coeffs = new Float64Array(PH_LOW * PH_LOW)
    let k = 0
    for (let u = 0; u < PH_LOW; u++)
      for (let v = 0; v < PH_LOW; v++) coeffs[k++] = dct[u * PH_SIZE + v]
    const sortedNoDC = Array.from(coeffs).slice(1).sort((a, b) => a - b)
    const median = sortedNoDC[Math.floor(sortedNoDC.length / 2)]

    const hash = new Uint8Array(32)
    for (let i = 0; i < PH_LOW * PH_LOW; i++)
      if (coeffs[i] > median) hash[i >> 3] |= (1 << (7 - (i & 7)))

    return Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('')
  } catch (e) {
    return null
  }
}

// 256-bit pHash of a 32×32 greyscale Float64Array - the same DCT-hash core the
// writer uses. Used for the §5.3.1 region hash.
function pHashGrey32(grey) {
  const rows = new Float64Array(PH_SIZE * PH_SIZE)
  for (let y = 0; y < PH_SIZE; y++)
    for (let u = 0; u < PH_SIZE; u++) {
      let sum = 0
      for (let x = 0; x < PH_SIZE; x++) sum += grey[y * PH_SIZE + x] * phDctBasis[u * PH_SIZE + x]
      rows[y * PH_SIZE + u] = sum
    }
  const dct = new Float64Array(PH_SIZE * PH_SIZE)
  for (let u = 0; u < PH_SIZE; u++)
    for (let v = 0; v < PH_SIZE; v++) {
      let sum = 0
      for (let y = 0; y < PH_SIZE; y++) sum += rows[y * PH_SIZE + v] * phDctBasis[u * PH_SIZE + y]
      dct[u * PH_SIZE + v] = sum
    }
  const coeffs = new Float64Array(PH_LOW * PH_LOW)
  let k = 0
  for (let u = 0; u < PH_LOW; u++)
    for (let v = 0; v < PH_LOW; v++) coeffs[k++] = dct[u * PH_SIZE + v]
  const sortedNoDC = Array.from(coeffs).slice(1).sort((a, b) => a - b)
  const median = sortedNoDC[Math.floor(sortedNoDC.length / 2)]
  const hash = new Uint8Array(32)
  for (let i = 0; i < PH_LOW * PH_LOW; i++)
    if (coeffs[i] > median) hash[i >> 3] |= (1 << (7 - (i & 7)))
  return Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Region hash of the query image (spec §5.3.1): crop the %-bounds region (with the
// same margin the writer uses), downscale to 32×32 greyscale, pHash. MUST match
// siml-writer/computeRegionHash. Returns hex or null.
function getRegionHashFromImageElement(img, boundsPct) {
  try {
    if (!boundsPct) return null
    const W = img.naturalWidth || img.width
    const H = img.naturalHeight || img.height
    if (!W || !H) return null
    const padX = 2, padY = 4 // percent - must match the writer
    let left = Math.round(((boundsPct.x - padX) / 100) * W)
    let top = Math.round(((boundsPct.y - padY) / 100) * H)
    let cw = Math.round(((boundsPct.w + 2 * padX) / 100) * W)
    let ch = Math.round(((boundsPct.h + 2 * padY) / 100) * H)
    left = Math.max(0, Math.min(left, W - 1))
    top = Math.max(0, Math.min(top, H - 1))
    cw = Math.max(1, Math.min(cw, W - left))
    ch = Math.max(1, Math.min(ch, H - top))

    const canvas = document.createElement('canvas')
    canvas.width = PH_SIZE
    canvas.height = PH_SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, left, top, cw, ch, 0, 0, PH_SIZE, PH_SIZE)
    const data = ctx.getImageData(0, 0, PH_SIZE, PH_SIZE).data
    const grey = new Float64Array(PH_SIZE * PH_SIZE)
    for (let i = 0; i < PH_SIZE * PH_SIZE; i++)
      grey[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
    return pHashGrey32(grey)
  } catch (e) {
    return null
  }
}

function getWatermarkFromImageElement(img, expectedLength = 16) {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = CANONICAL_WIDTH
    const aspect = img.naturalHeight / img.naturalWidth
    canvas.height = Math.round((CANONICAL_WIDTH * aspect) / 8) * 8
    
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    
    const payloadBytes = extractWatermark(imgData.data, canvas.width, canvas.height, expectedLength)
    if (!payloadBytes) return null
    return new TextDecoder('utf-8').decode(payloadBytes).replace(/\0/g, '')
  } catch (e) {
    return null
  }
}

module.exports = {
  extractPayload,
  detectFormat,
  getPHashFromImageElement,
  getRegionHashFromImageElement,
  getWatermarkFromImageElement,
  extractWatermark
}
