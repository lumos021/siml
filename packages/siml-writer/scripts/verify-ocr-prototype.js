// scripts/verify-ocr-prototype.js
// Prototype of the T1 `verify` payload mode (spec v0.4 draft, "T1v"):
// the watermark carries a tiny CHECKSUM of the authored text instead of the
// text itself. At read time, OCR reads the visible glyphs and the checksum
// turns it from a guesser into a search oracle - ambiguous characters are
// enumerated until the checksum matches, recovering the EXACT authored text
// plus its true position (OCR boxes), fully offline.
//
// Why this matters:
//   direct mode: 16-byte payload -> 192-bit stream -> ~42 reps/bit at 1024x512
//   verify mode:  6-byte payload -> 112-bit stream -> ~73 reps/bit (1.7x)
// Shorter stream = deeper survival floor for the checksum itself, and the
// text capacity becomes unlimited (one checksum covers any number of fields).
//
// Run: node scripts/verify-ocr-prototype.js
const path = require('path')
const sharp = require('sharp')
const Tesseract = require('tesseract.js')
const { embedWatermark, extractWatermark, CANONICAL_WIDTH } = require('../src/watermark')

const W = 1024, H = 512
const PHONE = '+91 98765 43210'

// ---- verify-mode payload: "V1" magic + CRC32 of the normalized field ----
// Normalization removes what OCR legitimately varies on (whitespace) while
// keeping every character that matters. Phone fields normalize to +digits.
function normalizePhone (s) {
  const t = s.replace(/[^+\d]/g, '')
  return t.startsWith('+') ? '+' + t.slice(1).replace(/\+/g, '') : t
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()
function crc32 (str) {
  const bytes = Buffer.from(str, 'utf8')
  let crc = 0xFFFFFFFF
  for (const b of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ b) & 0xFF]
  return (crc ^ 0xFFFFFFFF) >>> 0
}

const VERIFY_PAYLOAD_LEN = 6 // "V1" + 4-byte CRC32
function buildVerifyPayload (fieldText) {
  const p = Buffer.alloc(VERIFY_PAYLOAD_LEN)
  p.write('V1', 0, 'ascii')
  p.writeUInt32BE(crc32(normalizePhone(fieldText)), 2)
  return p
}

// ---- the oracle search: enumerate OCR confusions until the checksum matches ----
// Substitutions cover the classic digit/letter confusions. Bounded beam so a
// pathological read cannot explode; if nothing matches, FAIL LOUD (null).
const CONFUSIONS = {
  O: ['0'], o: ['0'], D: ['0'], Q: ['0'],
  l: ['1'], I: ['1'], i: ['1'], '|': ['1'], '!': ['1'],
  Z: ['2'], z: ['2'],
  E: ['3'],
  A: ['4'], h: ['4'],
  S: ['5'], s: ['5'],
  G: ['6'], b: ['6'],
  T: ['7'], '?': ['7'],
  B: ['8'],
  g: ['9'], q: ['9'],
  '0': ['O'], '1': ['l'], '5': ['S'], '8': ['B'] // reverse direction, rarely needed
}
const MAX_CANDIDATES = 4096

function * candidates (raw) {
  // Positions that have alternatives
  const chars = [...raw]
  const slots = []
  chars.forEach((ch, idx) => { if (CONFUSIONS[ch]) slots.push(idx) })
  // Breadth-first over substitution masks, capped
  const total = Math.min(1 << slots.length, MAX_CANDIDATES)
  for (let mask = 0; mask < total; mask++) {
    const c = [...chars]
    for (let s = 0; s < slots.length; s++) {
      if (mask & (1 << s)) c[slots[s]] = CONFUSIONS[chars[slots[s]]][0]
    }
    yield c.join('')
  }
}

function oracleSearch (ocrText, expectedCrc) {
  let tried = 0
  for (const cand of candidates(ocrText)) {
    tried++
    const norm = normalizePhone(cand)
    if (norm.length >= 8 && crc32(norm) === expectedCrc) {
      return { exact: norm, tried }
    }
  }
  return { exact: null, tried }
}

// ---- fixture: banner with the phone number in the pixels ----
function bannerSvg () {
  return Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#1a1630"/><stop offset="0.6" stop-color="#4a4290"/><stop offset="1" stop-color="#2dd4a8"/>
  </linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>
  <text x="60" y="130" font-family="Arial" font-size="54" font-weight="bold" fill="#ffffff">Premium Property Sale</text>
  <text x="60" y="270" font-family="Arial" font-size="46" font-weight="bold" fill="#ffffff">Call: ${PHONE}</text>
  <text x="60" y="380" font-family="Arial" font-size="30" fill="#e8e8f0">123 Demo Street, SF</text>
</svg>`)
}

async function embedInto (svg, payload) {
  const { data, info } = await sharp(svg).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const rgba = new Uint8ClampedArray(data)
  embedWatermark(rgba, info.width, info.height, payload)
  return sharp(Buffer.from(rgba.buffer), { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
}

async function extractFrom (deliveredBuf, payloadLen) {
  const meta = await sharp(deliveredBuf).metadata()
  const h = Math.round((meta.height / meta.width) * CANONICAL_WIDTH / 8) * 8
  const { data, info } = await sharp(deliveredBuf).resize(CANONICAL_WIDTH, h, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return extractWatermark(new Uint8ClampedArray(data), info.width, info.height, payloadLen)
}

async function main () {
  console.log('== T1 verify-mode prototype: checksum-guided OCR ==\n')
  console.log(`authored field: "${PHONE}"  (normalized: ${normalizePhone(PHONE)}, crc32: ${crc32(normalizePhone(PHONE)).toString(16)})\n`)

  const directPayload = Buffer.alloc(16); directPayload.write(PHONE, 'utf8')
  const verifyPayload = buildVerifyPayload(PHONE)

  const markedDirect = await embedInto(bannerSvg(), directPayload)
  const markedVerify = await embedInto(bannerSvg(), verifyPayload)

  const ATTACKS = [
    ['jpeg q75 @1024', b => sharp(b).jpeg({ quality: 75 }).toBuffer()],
    ['ds900 + q75', b => sharp(b).resize({ width: 900 }).jpeg({ quality: 75 }).toBuffer()],
    ['ds800 + q75', b => sharp(b).resize({ width: 800 }).jpeg({ quality: 75 }).toBuffer()],
    ['ds700 + q75', b => sharp(b).resize({ width: 700 }).jpeg({ quality: 75 }).toBuffer()],
    ['ds640 + q75', b => sharp(b).resize({ width: 640 }).jpeg({ quality: 75 }).toBuffer()],
    ['ds560 + q75', b => sharp(b).resize({ width: 560 }).jpeg({ quality: 75 }).toBuffer()],
  ]

  console.log('-- Part 1: where does each payload mode\'s watermark survive? --')
  const survival = {}
  for (const [name, attack] of ATTACKS) {
    const d = await extractFrom(await attack(markedDirect), 16)
    const v = await extractFrom(await attack(markedVerify), VERIFY_PAYLOAD_LEN)
    const vOk = v && Buffer.from(v).slice(0, 2).toString('ascii') === 'V1'
    survival[name] = { direct: !!d, verify: vOk, verifyCrc: vOk ? Buffer.from(v).readUInt32BE(2) : null }
    console.log(`  ${name.padEnd(16)} direct(16B): ${d ? 'PASS' : 'dead'}   verify(6B): ${vOk ? 'PASS' : 'dead'}`)
  }

  console.log('\n-- Part 2: full verify-mode recovery on a wrecked image (checksum + OCR oracle) --')
  // Pick the harshest attack where the verify checksum still survives
  const alive = ATTACKS.filter(([n]) => survival[n].verify)
  const [attackName, attackFn] = alive[alive.length - 1]
  console.log(`  attack: ${attackName}`)
  const delivered = await attackFn(markedVerify)
  const meta = await sharp(delivered).metadata()
  console.log(`  delivered image: ${meta.width}x${meta.height} jpeg`)

  const payload = await extractFrom(delivered, VERIFY_PAYLOAD_LEN)
  const expectedCrc = Buffer.from(payload).readUInt32BE(2)
  console.log(`  checksum recovered from pixels: ${expectedCrc.toString(16)}`)

  // OCR the delivered (degraded) image. tesseract.js v7: detailed output
  // (blocks with word boxes) must be requested explicitly on a worker.
  const pngForOcr = await sharp(delivered).png().toBuffer()
  const worker = await Tesseract.createWorker('eng')
  const { data: ocr } = await worker.recognize(pngForOcr, {}, { blocks: true, text: true })
  await worker.terminate()
  const lines = (ocr.blocks || []).flatMap(b => (b.paragraphs || []).flatMap(p => p.lines || []))
  console.log(`  OCR read ${lines.length} lines:`)

  let result = null
  for (const line of lines) {
    const raw = line.text.trim()
    if (!raw) continue
    const digitsish = raw.replace(/[^+\dOoIlZSBGgq|!? ]/g, '')
    console.log(`    "${raw}"`)
    // Try all word windows [start, end) and keep the TIGHTEST match, so a
    // label ("Call:") or trailing OCR junk doesn't inflate the rendered box -
    // the overlay must hug the actual value glyphs.
    const words = raw.split(/\s+/)
    let best = null
    for (let start = 0; start < words.length; start++) {
      for (let end = start + 1; end <= words.length; end++) {
        const windowText = words.slice(start, end).join(' ')
        const { exact, tried } = oracleSearch(windowText, expectedCrc)
        if (exact && (!best || (end - start) < (best.end - best.start))) {
          best = { exact, windowText, tried, start, end }
        }
      }
    }
    if (best && !result) {
      const wordBoxes = line.words.slice(best.start, best.end).map(w => w.bbox)
      const x0 = Math.min(...wordBoxes.map(b => b.x0)), y0 = Math.min(...wordBoxes.map(b => b.y0))
      const x1 = Math.max(...wordBoxes.map(b => b.x1)), y1 = Math.max(...wordBoxes.map(b => b.y1))
      result = {
        exact: best.exact,
        rawOcr: best.windowText,
        candidatesTried: best.tried,
        bounds: {
          x: +(100 * x0 / meta.width).toFixed(2),
          y: +(100 * y0 / meta.height).toFixed(2),
          w: +(100 * (x1 - x0) / meta.width).toFixed(2),
          h: +(100 * (y1 - y0) / meta.height).toFixed(2),
        }
      }
    }
    void digitsish
  }

  console.log('')
  if (result) {
    const corrected = normalizePhone(result.rawOcr) !== result.exact
    console.log('  ✔ VERIFIED EXACT RECOVERY')
    console.log(`    OCR raw read:   "${result.rawOcr}"${corrected ? '  (imperfect - corrected by the oracle)' : ''}`)
    console.log(`    exact value:    ${result.exact}   (checksum-proven, ${result.candidatesTried} candidate(s) tried)`)
    console.log(`    true position:  ${JSON.stringify(result.bounds)}  (%-bounds from OCR boxes -> overlay renders on the real glyphs)`)
    console.log(`    ground truth:   ${normalizePhone(PHONE)}  ${result.exact === normalizePhone(PHONE) ? '== MATCH' : '!! MISMATCH'}`)
  } else {
    console.log('  ✘ no OCR candidate matched the checksum -> FAIL LOUD (no value surfaced)')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
