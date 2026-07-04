// writer.test.js - Tests for the SIML writer v0.3
const path = require('path')
const fs = require('fs')
const sharp = require('sharp')
const { write } = require('../src/index')
const { deserializeJUMBF, serializeJUMBF } = require('../src/jumbf')
const { embedWatermark, extractWatermark, crc16, selectT1Payload, T1_CAPACITY } = require('../src/watermark')
const { hammingDistance, calculatePHashFromGreyscale, MATCH_THRESHOLD, STALE_THRESHOLD } = require('../src/fingerprint')
const { embedSIML: embedJPEG } = require('../src/embed-jpeg')

jest.setTimeout(60000) // T1 embedding runs 3 refinement passes; slow under parallel load

const FIXTURES = path.join(__dirname, 'fixtures')
const SAMPLE_PNG = path.join(FIXTURES, 'sample.png')
const SAMPLE_JPG = path.join(FIXTURES, 'sample.jpg')
const SAMPLE_WEBP = path.join(FIXTURES, 'sample.webp')
const SAMPLE_INPUT = path.join(FIXTURES, 'sample-input.json')

const OUTPUT_DIR = path.join(__dirname, 'output')
const OUT_PNG = path.join(OUTPUT_DIR, 'out.png')
const OUT_JPG = path.join(OUTPUT_DIR, 'out.jpg')
const OUT_WEBP = path.join(OUTPUT_DIR, 'out.webp')

beforeAll(async () => {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  }
  
  const baseImg = path.join(__dirname, '../../../AA24z3le.png')
  if (fs.existsSync(baseImg)) {
    fs.copyFileSync(baseImg, SAMPLE_PNG)
  } else {
    // No local base image (CI): fall back to the committed real photo
    // fixture the conformance suite already validates against.
    await sharp(path.join(__dirname, '../scripts/sample_bg.png')).png().toFile(SAMPLE_PNG)
  }
  await sharp(SAMPLE_PNG).jpeg().toFile(SAMPLE_JPG)
  await sharp(SAMPLE_PNG).webp({ lossless: false }).toFile(SAMPLE_WEBP)
})

afterAll(() => {
  try {
    if (fs.existsSync(OUTPUT_DIR)) {
      fs.rmSync(OUTPUT_DIR, { recursive: true, force: true })
    }
  } catch (e) {}
  try { if (fs.existsSync(SAMPLE_JPG)) fs.unlinkSync(SAMPLE_JPG) } catch (e) {}
  try { if (fs.existsSync(SAMPLE_WEBP)) fs.unlinkSync(SAMPLE_WEBP) } catch (e) {}
  try { if (fs.existsSync(SAMPLE_PNG)) fs.unlinkSync(SAMPLE_PNG) } catch (e) {}
})

function getValidDefinition() {
  return JSON.parse(fs.readFileSync(SAMPLE_INPUT, 'utf8'))
}

// TEST W-01: PNG siMl JUMBF box validation
test('W-01: PNG siMl chunk exists before IEND', async () => {
  const definition = getValidDefinition()
  await write({
    imagePath: SAMPLE_PNG,
    definition,
    outputPath: OUT_PNG,
    format: 'png',
  })

  const buf = fs.readFileSync(OUT_PNG)
  let pos = 8
  let foundSIML = false
  
  while (pos < buf.length) {
    if (pos + 8 > buf.length) break
    const len = buf.readUInt32BE(pos)
    const type = buf.slice(pos + 4, pos + 8).toString('ascii')
    
    if (type === 'siMl') {
      foundSIML = true
      const jumbfBytes = buf.subarray(pos + 8, pos + 8 + len)
      const decomp = deserializeJUMBF(jumbfBytes)
      expect(decomp).not.toBeNull()
      expect(decomp.siml).toBe('0.3')
    }
    if (type === 'IEND') break
    pos += 12 + len
  }
  expect(foundSIML).toBe(true)
})

// TEST W-04: JPEG APP11 JUMBF segment validation
test('W-04: JPEG APP11 JUMBF segment validation', async () => {
  const definition = getValidDefinition()
  await write({
    imagePath: SAMPLE_JPG,
    definition,
    outputPath: OUT_JPG,
    format: 'jpeg',
  })

  const buf = fs.readFileSync(OUT_JPG)
  let pos = 2
  let foundAPP11 = false

  while (pos < buf.length - 1) {
    const marker = buf.readUInt16BE(pos)
    if (marker === 0xFFDA) break
    if (marker === 0xFFEB) { // APP11
      foundAPP11 = true
      const segLen = buf.readUInt16BE(pos + 2)
      const signature = buf.slice(pos + 4, pos + 8).toString('ascii')
      expect(signature).toBe('JP02')
      
      const jumbfBytes = buf.slice(pos + 12, pos + 2 + segLen)
      const decomp = deserializeJUMBF(jumbfBytes)
      expect(decomp).not.toBeNull()
      expect(decomp.siml).toBe('0.3')
    }
    const segLen = buf.readUInt16BE(pos + 2)
    pos += 2 + segLen
  }
  expect(foundAPP11).toBe(true)
})

// TEST W-16: T1 Watermark embedding and extraction E2E
test('W-16: T1 watermark embedding and extraction', async () => {
  const definition = {
    permissions: { platformCanDisableSelection: true, platformCanDisableLinks: true, platformCanDisableAll: true },
    textLayer: [{
      id: 't1',
      text: 'WatermarkTest123', // exactly 16 chars (== T1 capacity)
      type: 'text',
      primary: true,            // §4.5.1: primary makes it the T1-carried field
      bounds: { x: 10, y: 10, w: 20, h: 5 },
      selectable: true
    }]
  }

  await write({
    imagePath: SAMPLE_PNG,
    definition,
    outputPath: OUT_PNG,
    format: 'png',
    embedWatermark: true
  })

  // Read watermarked image and extract raw pixels
  const { data, info } = await sharp(OUT_PNG)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  // Extract payload from pixels
  const extractedBytes = extractWatermark(data, info.width, info.height, 16)
  expect(extractedBytes).not.toBeNull()
  const extractedText = Buffer.from(extractedBytes).toString('utf8')
  expect(extractedText).toBe('WatermarkTest123')
})

// TEST W-24: T1 watermark + JPEG output (carrier-format must match output).
test('W-24: T1 + JPEG output produces a valid JPEG carrier', async () => {
  const definition = {
    permissions: { platformCanDisableSelection: true, platformCanDisableLinks: true, platformCanDisableAll: true },
    textLayer: [{ id: 't1', text: 'WatermarkTest123', type: 'text', primary: true, bounds: { x: 10, y: 10, w: 20, h: 5 }, selectable: true }],
  }
  await write({ imagePath: SAMPLE_JPG, definition, outputPath: OUT_JPG, format: 'jpeg', embedWatermark: true })
  const buf = fs.readFileSync(OUT_JPG)
  expect(buf[0]).toBe(0xFF)
  expect(buf[1]).toBe(0xD8) // valid JPEG SOI
  const meta = await sharp(OUT_JPG).metadata()
  expect(meta.format).toBe('jpeg')
})

// TEST W-17: T2 difference hash computation
test('W-17: T2 perceptual difference hash is registered', async () => {
  const definition = getValidDefinition()
  const res = await write({
    imagePath: SAMPLE_PNG,
    definition,
    outputPath: OUT_PNG,
    format: 'png',
    registerLocal: true
  })

  expect(res.dhash).not.toBeNull()
  expect(res.dhash.length).toBe(64) // 256 bits = 64 hex characters

  const registryPath = path.join(OUTPUT_DIR, 'siml-registry.json')
  expect(fs.existsSync(registryPath)).toBe(true)
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
  expect(registry[res.dhash]).toBeDefined()
  expect(registry[res.dhash].textLayer[0].text).toBe(definition.textLayer[0].text)
})

// TEST W-18: T1 CRC rejects a corrupted read instead of returning a wrong value.
// Embed into a synthetic raster, then flip enough luminance to corrupt some bits
// and assert extraction fails loudly (null) rather than surfacing wrong bytes.
test('W-18: T1 CRC fails loud on corruption (never a wrong value)', () => {
  const width = 256, height = 64 // 32x8 blocks - small but enough redundancy
  const rgba = new Uint8Array(width * height * 4)
  // mid-grey base so DCT coefficients have headroom
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 128
    rgba[i * 4 + 3] = 255
  }
  const payload = Buffer.from('CallMeMaybe12345', 'utf8') // 16 bytes
  embedWatermark(rgba, width, height, payload)

  // Clean read round-trips
  const clean = extractWatermark(rgba, width, height, 16)
  expect(clean).not.toBeNull()
  expect(Buffer.from(clean).toString('utf8')).toBe('CallMeMaybe12345')

  // Corrupt heavily: overwrite the top half of the image with noise so the
  // majority vote produces some wrong bits. CRC must reject (null), not lie.
  for (let i = 0; i < (width * height) / 2; i++) {
    const n = (i * 73) % 256
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = n
  }
  const corrupted = extractWatermark(rgba, width, height, 16)
  // Either a clean recovery (redundancy won) or null - but NEVER wrong bytes.
  if (corrupted !== null) {
    expect(Buffer.from(corrupted).toString('utf8')).toBe('CallMeMaybe12345')
  }

  // Deterministic reject: with the WHOLE image replaced by noise the signal is
  // gone, and the fail-loud chain (sync/RS/CRC) MUST return null. Without this
  // branch the reject path could go forever unexercised (the conditional above
  // passes vacuously whenever redundancy wins).
  for (let i = 0; i < width * height; i++) {
    const n = (i * 137 + ((i * i) % 251)) % 256
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = n
  }
  expect(extractWatermark(rgba, width, height, 16)).toBeNull()
})

// TEST W-25: §4.5.1 T1 payload selection + no-truncation guarantee.
describe('W-25: T1 payload selection (spec §4.5.1)', () => {
  const obj = (o) => ({ id: o.id || 'x', text: o.text, type: o.type || 'text', selectable: true, ...o })

  test('primary wins over actionable order', () => {
    const layer = [
      obj({ id: 'a', text: '111', type: 'phone', intent: 'actionable' }),
      obj({ id: 'b', text: '222', type: 'url', intent: 'actionable', primary: true }),
    ]
    const sel = selectT1Payload(layer, 'cid')
    expect(sel.payloadMode).toBe('direct')
    expect(Buffer.from(sel.payload).toString('utf8').replace(/\0/g, '')).toBe('222')
  })

  test('falls back to first actionable when no primary', () => {
    const layer = [
      obj({ id: 'a', text: 'hello', type: 'text' }),
      obj({ id: 'b', text: 'me@x.io', type: 'email', intent: 'actionable' }),
    ]
    const sel = selectT1Payload(layer, 'cid')
    expect(Buffer.from(sel.payload).toString('utf8').replace(/\0/g, '')).toBe('me@x.io')
  })

  test('readonly intent is not selected', () => {
    const layer = [obj({ id: 'a', text: '+19998887777', type: 'phone', intent: 'readonly' })]
    expect(selectT1Payload(layer, 'cid')).toBeNull() // skip T1
  })

  test('oversized value → id mode (never truncates)', () => {
    const long = 'https://example.com/a/very/long/path/that/will/not/fit'
    expect(Buffer.byteLength(long)).toBeGreaterThan(T1_CAPACITY)
    const sel = selectT1Payload([obj({ text: long, type: 'url', intent: 'actionable' })], 'cid42')
    expect(sel.payloadMode).toBe('id')
    expect(Buffer.from(sel.payload).toString('utf8').replace(/\0/g, '')).toBe('cid42')
  })

  test('value at exactly capacity fits (direct)', () => {
    const exact = 'A'.repeat(T1_CAPACITY)
    const sel = selectT1Payload([obj({ text: exact, type: 'url', intent: 'actionable' })], 'cid')
    expect(sel.payloadMode).toBe('direct')
    expect(Buffer.from(sel.payload).toString('utf8')).toBe(exact)
  })
})

// TEST G-01: GOLDEN FIXTURE - decode the COMMITTED demo sample and assert the
// exact known values. This is the anti-circularity guard: every other T1 test
// embeds and extracts with the same code, which proves consistency, not
// correctness - both sides could drift together. A frozen artifact from a past
// encoder breaks that loop across time: any wire-format change must either
// still decode history or consciously regenerate the goldens (make-samples).
test('G-01: committed sample decodes to the known golden values', async () => {
  const golden = path.join(__dirname, '../../siml-demo/public/test.siml.png')
  expect(fs.existsSync(golden)).toBe(true) // the sample is committed; no vacuous pass

  // T0: the container carries the known layer.
  const buf = fs.readFileSync(golden)
  let payload = null
  let pos = 8
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.slice(pos + 4, pos + 8).toString('ascii')
    if (type === 'siMl') { payload = deserializeJUMBF(buf.subarray(pos + 8, pos + 8 + len)); break }
    if (type === 'IEND') break
    pos += 12 + len
  }
  expect(payload).not.toBeNull()
  expect(payload.contentId).toBe('siml-sample-banner')
  const phoneObj = payload.textLayer.find(o => o.type === 'phone')
  expect(phoneObj.text).toBe('+91 98765 43210')
  expect(phoneObj.primary).toBe(true)

  // T1: the pixels carry the phone (direct mode), decoded from the raster alone.
  const { data, info } = await sharp(golden).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const t1 = extractWatermark(data, info.width, info.height, 16)
  expect(t1).not.toBeNull()
  expect(Buffer.from(t1).toString('utf8').replace(/ /g, '')).toBe('+91 98765 43210')
})

// TEST W-19: T1 crc16 matches CCITT-FALSE check value (0x29B1 for "123456789").
test('W-19: crc16 matches CCITT-FALSE reference vector', () => {
  expect(crc16(Buffer.from('123456789', 'ascii'))).toBe(0x29B1)
})

// TEST W-21: T0 decompression cap. A valid small JUMBF round-trips; a forged
// superbox whose json box claims > 4 MiB is rejected (null), not parsed.
test('W-21: JUMBF rejects oversized json box (decompression-bomb cap)', () => {
  // Sanity: a normal box round-trips
  const good = serializeJUMBF({ siml: '0.3', textLayer: [] })
  expect(deserializeJUMBF(good)).not.toBeNull()

  // Forge a superbox with a json box header claiming a huge length
  const jumbd = good.slice(8, good.indexOf(Buffer.from('json')) ) // up to json box
  const fakeJson = Buffer.alloc(8)
  fakeJson.writeUInt32BE(8 + (5 * 1024 * 1024), 0) // boxLength = 8 + 5 MiB
  fakeJson.write('json', 4, 'ascii')
  const body = Buffer.concat([jumbd, fakeJson])
  const superbox = Buffer.alloc(8)
  superbox.writeUInt32BE(8 + body.length, 0)
  superbox.write('jumb', 4, 'ascii')
  const forged = Buffer.concat([superbox, body])

  expect(deserializeJUMBF(forged)).toBeNull()
})

// TEST W-23: pHash is DCT-based, 256-bit, and robust - a JPEG-recompressed copy
// of an image lands within the match threshold of the original, while a distinct
// image lands far outside it (spec §5.3 discrimination property).
test('W-23: pHash discriminates recompressed-same from different image', async () => {
  if (!fs.existsSync(SAMPLE_PNG)) return // base fixture not available

  const phashOf = async (input) => {
    const grey = await sharp(input).resize(32, 32, { fit: 'fill' }).greyscale().raw().toBuffer()
    return calculatePHashFromGreyscale(grey)
  }

  const orig = await phashOf(SAMPLE_PNG)
  expect(orig.length).toBe(32) // 256 bits

  // Same image, brutal JPEG recompression
  const recompressed = await sharp(SAMPLE_PNG).jpeg({ quality: 30 }).toBuffer()
  const same = await phashOf(recompressed)
  expect(hammingDistance(orig, same)).toBeLessThanOrEqual(MATCH_THRESHOLD)

  // A clearly different image (inverted) must sit well outside the threshold
  const inverted = await sharp(SAMPLE_PNG).negate().toBuffer()
  const diff = await phashOf(inverted)
  expect(hammingDistance(orig, diff)).toBeGreaterThan(MATCH_THRESHOLD)
})

// TEST W-22: JPEG APP11 overflow fails loud instead of silently corrupting.
test('W-22: JPEG embed throws on payload too large for one APP11 segment', () => {
  // Minimal valid JPEG skeleton: SOI + SOS + EOI
  const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9])
  const tmpIn = path.join(OUTPUT_DIR, 'tiny.jpg')
  const tmpOut = path.join(OUTPUT_DIR, 'tiny-out.jpg')
  fs.writeFileSync(tmpIn, jpeg)

  // ~70 KB of text → JUMBF segment exceeds the 16-bit length field
  const huge = 'x'.repeat(70 * 1024)
  const payload = { siml: '0.3', permissions: {}, textLayer: [{ id: 'a', text: huge }] }

  expect(() => embedJPEG(tmpIn, payload, tmpOut)).toThrow(/too large/i)
})

// TEST W-20: hammingDistance math sanity against hand-computed vectors, and the
// comparisons use the RATIFIED threshold constant (was hardcoded to a stale 12,
// which would have kept passing even if the ratified value drifted).
test('W-20: hammingDistance math + ratified threshold constant', () => {
  const a = Buffer.alloc(32, 0x00)
  const near = Buffer.alloc(32, 0x00); near[0] = 0x07 // 3 bits set → dist 3
  const far = Buffer.alloc(32, 0xFF)                  // dist 256

  expect(hammingDistance(a, near)).toBe(3)
  expect(hammingDistance(a, far)).toBe(256)
  expect(hammingDistance(a, near)).toBeLessThanOrEqual(MATCH_THRESHOLD)
  expect(hammingDistance(a, far)).toBeGreaterThan(MATCH_THRESHOLD)
})

// TEST W-26: pixelDigest staleness (spec §9.3) end-to-end.
// (a) write() stores a root pixelDigest; an untouched re-encode of the SAME pixels
//     stays within tolerance (FRESH). (b) the container copied onto EDITED pixels
//     diverges past tolerance (STALE) - the accidental-cloaking case.
test('W-26: pixelDigest is written and detects fresh vs stale pixels', async () => {
  if (!fs.existsSync(SAMPLE_PNG)) return
  const definition = {
    contentId: 'stale-test',
    permissions: { platformCanDisableSelection: true, platformCanDisableLinks: true, platformCanDisableAll: false },
    textLayer: [{ id: 'p', text: '+91 98765 43210', type: 'phone', intent: 'actionable', primary: true,
      bounds: { x: 5, y: 10, w: 40, h: 8 }, selectable: true, label: 'Call' }],
  }
  await write({ imagePath: SAMPLE_PNG, definition, outputPath: OUT_PNG, format: 'png', registerLocal: false })

  // The written layer carries a pixelDigest.
  const buf = fs.readFileSync(OUT_PNG)
  let payload = null
  let pos = 8
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.slice(pos + 4, pos + 8).toString('ascii')
    if (type === 'siMl') { payload = deserializeJUMBF(buf.subarray(pos + 8, pos + 8 + len)); break }
    if (type === 'IEND') break
    pos += 12 + len
  }
  expect(payload).not.toBeNull()
  expect(typeof payload.pixelDigest).toBe('string')

  const stored = Buffer.from(payload.pixelDigest, 'hex')
  const digestOf = async (b) =>
    calculatePHashFromGreyscale(await sharp(b).resize(32, 32, { fit: 'fill' }).greyscale().raw().toBuffer())

  // (a) FRESH: re-encode the delivered image, recompute → within tolerance.
  const reenc = await sharp(OUT_PNG).jpeg({ quality: 50 }).toBuffer()
  expect(hammingDistance(stored, await digestOf(reenc))).toBeLessThanOrEqual(STALE_THRESHOLD)

  // (b) STALE: paint a different number over the pixels (container unchanged) →
  // recomputed digest diverges past tolerance.
  const edited = await sharp(OUT_PNG)
    .composite([{ input: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="512">' +
      '<rect width="1024" height="512" fill="#222"/>' +
      '<text x="40" y="260" font-size="90" fill="#fff">CALL 1-800-SCAM</text></svg>'), top: 0, left: 0 }])
    .png().toBuffer()
  expect(hammingDistance(stored, await digestOf(edited))).toBeGreaterThan(STALE_THRESHOLD)
})
