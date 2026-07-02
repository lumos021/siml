// scripts/compare-embedders.js
// 1. Proves the demo editor's browser-port embedder is bit-identical to the
//    canonical writer embedder (same pixels in, same pixels out).
// 2. Maps T1 survival across content types x channel attacks, decoding the way
//    the viewer does (renormalize to canonical width, then extract).
// Run: node scripts/compare-embedders.js
const sharp = require('sharp')
const { embedWatermark, extractWatermark, CANONICAL_WIDTH } = require('../src/watermark')

const W = 1024, H = 512
const PAYLOAD_TEXT = '+91 98765 43210'
const payload = Buffer.alloc(16)
payload.write(PAYLOAD_TEXT, 'utf8')

// ---- browser-port embedder, copied verbatim from siml-demo create/page.tsx ----
// (TypeScript annotations stripped; logic untouched. If this drifts from the
// page, the equivalence check below is the alarm.)
const RS_EXP_C = new Uint8Array(512)
const RS_LOG_C = new Uint8Array(256)
;(function () {
  let x = 1
  for (let i = 0; i < 255; i++) { RS_EXP_C[i] = x; RS_LOG_C[x] = i; x <<= 1; if (x & 256) x ^= 0x11d }
  for (let i = 255; i < 512; i++) RS_EXP_C[i] = RS_EXP_C[i - 255]
})()
const cRsMul = (a, b) => (a && b) ? RS_EXP_C[RS_LOG_C[a] + RS_LOG_C[b]] : 0
const cRsPMulBE = (p, q) => {
  const r = new Array(p.length + q.length - 1).fill(0)
  for (let i = 0; i < p.length; i++) for (let j = 0; j < q.length; j++) r[i + j] ^= cRsMul(p[i], q[j])
  return r
}
function cRsEncode (data, nsym) {
  let g = [1]
  for (let i = 0; i < nsym; i++) g = cRsPMulBE(g, [1, RS_EXP_C[i]])
  const msg = [...data, ...new Array(nsym).fill(0)]
  for (let i = 0; i < data.length; i++) {
    if (!msg[i]) continue
    for (let j = 1; j < g.length; j++) msg[i + j] ^= cRsMul(g[j], msg[i])
  }
  // Systematic codeword = ORIGINAL data + parity remainder. The division loop
  // mutates the data positions as it runs, so they must be restored (this
  // missing restore was the bug that made every editor-embedded T1 undecodable).
  return [...data, ...msg.slice(data.length)]
}
const SYNC_TAG = 0xD4B3
const Q = 26
const QIM_MARGIN = 18 // MUST match siml-writer
const TEXTURE_EMBED_STDDEV = 8
const MIN_TEXTURED_REPS = 8
const Q_SMOOTH = 13
const RS_NSYM = 4
const cosTable = new Float32Array(8 * 8)
for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) cosTable[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16)
const cCoeff = w => w === 0 ? 1 / Math.sqrt(2) : 1
function dct2d (block) {
  const out = new Float32Array(64)
  for (let u = 0; u < 8; u++) {
    const cu = cCoeff(u)
    for (let v = 0; v < 8; v++) {
      const cv = cCoeff(v)
      let sum = 0
      for (let x = 0; x < 8; x++) {
        const cosX = cosTable[u * 8 + x]
        for (let y = 0; y < 8; y++) sum += block[x * 8 + y] * cosX * cosTable[v * 8 + y]
      }
      out[u * 8 + v] = 0.25 * cu * cv * sum
    }
  }
  return out
}
function idct2d (dctBlock) {
  const out = new Float32Array(64)
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let sum = 0
      for (let u = 0; u < 8; u++) {
        const cu = cCoeff(u)
        const cosX = cosTable[u * 8 + x]
        for (let v = 0; v < 8; v++) sum += cu * cCoeff(v) * dctBlock[u * 8 + v] * cosX * cosTable[v * 8 + y]
      }
      out[x * 8 + y] = 0.25 * sum
    }
  }
  return out
}
function crc16 (bytes) {
  let crc = 0xFFFF
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8
    for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF
  }
  return crc & 0xFFFF
}
function portEmbed (rgba, width, height, text) {
  const payloadBytes = new Uint8Array(16)
  payloadBytes.set(new TextEncoder().encode(text))
  const crc = crc16(payloadBytes)
  const rsInput = [...Array.from(payloadBytes), (crc >> 8) & 0xFF, crc & 0xFF]
  const rsCoded = cRsEncode(rsInput, RS_NSYM)
  const bits = []
  for (let i = 0; i < 16; i++) bits.push((SYNC_TAG >> (15 - i)) & 1)
  for (const byte of rsCoded) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1)
  const blocksX = Math.floor(width / 8)
  const blocksY = Math.floor(height / 8)
  const Y0 = new Float32Array(width * height)
  for (let i = 0; i < width * height; i++) Y0[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]
  const mask = new Uint8Array(blocksX * blocksY)
  let eligible = 0
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      let m = 0
      for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) m += Y0[((by * 8 + x) * width) + (bx * 8 + y)]
      m /= 64
      let v = 0
      for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) { const d = Y0[((by * 8 + x) * width) + (bx * 8 + y)] - m; v += d * d }
      if (Math.sqrt(v / 64) >= TEXTURE_EMBED_STDDEV) { mask[by * blocksX + bx] = 1; eligible++ }
    }
  }
  const selective = eligible >= MIN_TEXTURED_REPS * bits.length
  if (!selective) {
    for (let i = 0; i < mask.length; i++) if (!mask[i]) mask[i] = 2
  }
  const EMBED_PASSES = 3
  for (let pass = 0; pass < EMBED_PASSES; pass++) portEmbedPass(rgba, width, height, bits, mask)
}
function portEmbedPass (rgba, width, height, bits, mask) {
  const Y = new Float32Array(width * height)
  for (let i = 0; i < width * height; i++) Y[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]
  const blocksX = Math.floor(width / 8)
  const blocksY = Math.floor(height / 8)
  const bitLength = bits.length
  const block = new Float32Array(64)
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const blockIndex = by * blocksX + bx
      const mode = mask[blockIndex]
      if (!mode) continue
      for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) block[x * 8 + y] = Y[((by * 8 + x) * width) + (bx * 8 + y)]
      const dct = dct2d(block)
      const targetBit = bits[blockIndex % bitLength]
      const coeffVal = dct[2 * 8 + 1]
      const q = mode === 2 ? Q_SMOOTH : Q
      let quantum = Math.round(coeffVal / q)
      const isEven = ((quantum % 2) + 2) % 2 === 0
      if (isEven !== (targetBit === 0)) {
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
      for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) Y[((by * 8 + x) * width) + (bx * 8 + y)] = reconstructed[x * 8 + y]
    }
  }
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2]
    const oldY = 0.299 * r + 0.587 * g + 0.114 * b
    const delta = Y[i] - oldY
    rgba[i * 4] = Math.round(Math.max(0, Math.min(255, r + delta)))
    rgba[i * 4 + 1] = Math.round(Math.max(0, Math.min(255, g + delta)))
    rgba[i * 4 + 2] = Math.round(Math.max(0, Math.min(255, b + delta)))
  }
}
// ---- end browser port ----

function svgBanner (bg, fg, extra = '') {
  return Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  ${bg}
  <text x="60" y="140" font-family="Arial" font-size="52" font-weight="bold" fill="${fg}">Premium Property Sale</text>
  <text x="60" y="280" font-family="Arial" font-size="40" fill="${fg}">Call: ${PAYLOAD_TEXT}</text>
  <text x="60" y="380" font-family="Arial" font-size="28" fill="${fg}">123 Demo Street, SF</text>
  ${extra}
</svg>`)
}

const CONTENTS = {
  'gradient-banner': svgBanner(`<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0f0c1b"/><stop offset="0.5" stop-color="#6c63ff"/><stop offset="1" stop-color="#2dd4a8"/>
    </linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>`, '#ffffff'),
  'white-flyer': svgBanner('<rect width="100%" height="100%" fill="#ffffff"/>', '#111111'),
  'black-card': svgBanner('<rect width="100%" height="100%" fill="#0a0a0f"/>', '#f5f5f5'),
  'mid-grey': svgBanner('<rect width="100%" height="100%" fill="#808080"/>', '#ffffff'),
}

async function rgbaOf (input) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height }
}

async function pngFromRgba (rgba, width, height) {
  return sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width, height, channels: 4 } }).png().toBuffer()
}

const ATTACKS = {
  'none (png)': buf => sharp(buf).png().toBuffer(),
  'jpeg q85': buf => sharp(buf).jpeg({ quality: 85 }).toBuffer(),
  'jpeg q75 (whatsapp-like)': buf => sharp(buf).jpeg({ quality: 75, chromaSubsampling: '4:2:0' }).toBuffer(),
  'jpeg q60': buf => sharp(buf).jpeg({ quality: 60 }).toBuffer(),
  'jpeg q40': buf => sharp(buf).jpeg({ quality: 40 }).toBuffer(),
  'jpeg q30': buf => sharp(buf).jpeg({ quality: 30 }).toBuffer(),
  'webp q75': buf => sharp(buf).webp({ quality: 75 }).toBuffer(),
  'ds900 + jpeg q75': buf => sharp(buf).resize({ width: 900 }).jpeg({ quality: 75 }).toBuffer(),
  'ds640 + jpeg q75 (expect fail -> T2)': buf => sharp(buf).resize({ width: 640 }).jpeg({ quality: 75 }).toBuffer(),
}

// Decode the way the viewer does: renormalize to canonical width, height to
// nearest multiple of 8, then extract.
async function viewerDecode (deliveredBuf) {
  const meta = await sharp(deliveredBuf).metadata()
  const aspect = meta.height / meta.width
  const h = Math.round((CANONICAL_WIDTH * aspect) / 8) * 8
  const { data, info } = await sharp(deliveredBuf)
    .resize(CANONICAL_WIDTH, h, { fit: 'fill' })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const out = extractWatermark(new Uint8ClampedArray(data), info.width, info.height, 16)
  if (!out) return null
  return Buffer.from(out).toString('utf8').replace(/\0/g, '')
}

async function main () {
  // ---- Part 1: equivalence ----
  console.log('== Part 1: browser-port vs canonical embedder equivalence ==')
  const base = await rgbaOf(CONTENTS['gradient-banner'])
  const a = new Uint8ClampedArray(base.data)
  const b = new Uint8ClampedArray(base.data)
  embedWatermark(a, base.width, base.height, payload)
  portEmbed(b, base.width, base.height, PAYLOAD_TEXT)
  let diff = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++
  console.log(diff === 0
    ? 'IDENTICAL: same pixels out, byte for byte. The port is not the weak link.'
    : `DIFFER in ${diff} bytes (${(100 * diff / a.length).toFixed(3)}%) - port drift, investigate.`)

  // ---- Part 2: content x attack survival matrix ----
  console.log('\n== Part 2: content x attack matrix (canonical embed, viewer-style decode) ==')
  const attackNames = Object.keys(ATTACKS)
  const colw = Math.max(...attackNames.map(s => s.length)) + 2
  for (const [name, svg] of Object.entries(CONTENTS)) {
    const src = await rgbaOf(svg)
    const rgba = new Uint8ClampedArray(src.data)
    embedWatermark(rgba, src.width, src.height, payload)
    const marked = await pngFromRgba(rgba, src.width, src.height)
    console.log(`\n  ${name}`)
    for (const attack of attackNames) {
      const delivered = await ATTACKS[attack](marked)
      const got = await viewerDecode(delivered)
      const ok = got === PAYLOAD_TEXT
      console.log(`    ${attack.padEnd(colw)} ${ok ? 'PASS' : (got === null ? 'REJECT (loud, no value)' : `WRONG VALUE: ${got}`)}`)
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
