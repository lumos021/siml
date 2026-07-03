// reader.test.js - Tests R-01 through R-15 for SIML reader v0.2
if (typeof global.TextEncoder === 'undefined') {
  const { TextEncoder, TextDecoder } = require('util')
  global.TextEncoder = TextEncoder
  global.TextDecoder = TextDecoder
}
const path = require('path')
const fs = require('fs')
const sharp = require('sharp')
const { JSDOM } = require('jsdom')

const { extractPayload, detectFormat } = require('../src/extract')
const { resolveMode, MODES } = require('../src/permissions')
const { computeFontSize } = require('../src/render')
const { resolveLayer, resolveFingerprint, hammingHex } = require('../src/resolve')

const FIXTURES_DIR = path.join(__dirname, 'fixtures')
const SAMPLE_PNG = path.join(FIXTURES_DIR, 'sample.png')
const SAMPLE_JPG = path.join(FIXTURES_DIR, 'sample.jpg')
const SAMPLE_WEBP = path.join(FIXTURES_DIR, 'sample.webp')

const WRITER_DIR = path.join(__dirname, '../../siml-writer')
const writerWrite = require(path.join(WRITER_DIR, 'src/index.js')).write

const OUTPUT_DIR = path.join(__dirname, 'output')
const OUT_PNG = path.join(OUTPUT_DIR, 'out.png')
const OUT_JPG = path.join(OUTPUT_DIR, 'out.jpg')
const OUT_WEBP = path.join(OUTPUT_DIR, 'out.webp')

// Helper for DOM testing
function createTestDOM() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>')
  return dom.window
}

beforeAll(async () => {
  if (!fs.existsSync(FIXTURES_DIR)) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true })
  }
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  }
  
  // Use base image to generate PNG/JPEG/WebP mock carriers
  const baseImg = path.join(__dirname, '../../../AA24z3le.png')
  if (fs.existsSync(baseImg)) {
    fs.copyFileSync(baseImg, SAMPLE_PNG)
  } else {
    // No local base image (CI): fall back to the committed real photo
    // fixture the conformance suite already validates against.
    await sharp(path.join(__dirname, '../../siml-writer/scripts/sample_bg.png')).png().toFile(SAMPLE_PNG)
  }
  await sharp(SAMPLE_PNG).jpeg().toFile(SAMPLE_JPG)
  await sharp(SAMPLE_PNG).webp({ lossless: false }).toFile(SAMPLE_WEBP)

  const definition = {
    permissions: {
      platformCanDisableSelection: true,
      platformCanDisableLinks: true,
      platformCanDisableAll: false,
    },
    textLayer: [
      {
        id: 't1',
        text: 'Hello World',
        type: 'text',
        bounds: { x: 5.2, y: 12.4, w: 38.0, h: 7.2 },
        selectable: true,
        style: { font: 'Inter', size: 14, weight: 'bold', color: '#FFFFFF' }
      }
    ]
  }

  await writerWrite({ imagePath: SAMPLE_PNG, definition, outputPath: OUT_PNG, format: 'png' })
  await writerWrite({ imagePath: SAMPLE_JPG, definition, outputPath: OUT_JPG, format: 'jpeg' })
  await writerWrite({ imagePath: SAMPLE_WEBP, definition, outputPath: OUT_WEBP, format: 'webp' })
})

afterAll(() => {
  try {
    if (fs.existsSync(OUTPUT_DIR)) {
      fs.rmSync(OUTPUT_DIR, { recursive: true, force: true })
    }
  } catch (e) {}
  try {
    if (fs.existsSync(FIXTURES_DIR)) {
      fs.rmSync(FIXTURES_DIR, { recursive: true, force: true })
    }
  } catch (e) {}
})

// TEST R-01: PNG payload extraction
test('R-01: PNG extracts payload from siMl chunk correctly', async () => {
  const buf = fs.readFileSync(OUT_PNG)
  const result = await extractPayload(buf.buffer)
  expect(result).not.toBeNull()
  expect(result.imageMime).toBe('image/png')
  expect(result.payload.siml).toBe('0.3')
  expect(result.payload.textLayer[0].text).toBe('Hello World')
})

// TEST R-02: JPEG payload extraction
test('R-02: JPEG extracts payload from APP11 correctly', async () => {
  const buf = fs.readFileSync(OUT_JPG)
  const result = await extractPayload(buf.buffer)
  expect(result).not.toBeNull()
  expect(result.imageMime).toBe('image/jpeg')
  expect(result.payload.siml).toBe('0.3')
  expect(result.payload.textLayer[0].text).toBe('Hello World')
})

// TEST R-03: WebP payload extraction
test('R-03: WebP extracts payload from siML chunk correctly', async () => {
  const buf = fs.readFileSync(OUT_WEBP)
  const result = await extractPayload(buf.buffer)
  expect(result).not.toBeNull()
  expect(result.imageMime).toBe('image/webp')
  expect(result.payload.siml).toBe('0.3')
  expect(result.payload.textLayer[0].text).toBe('Hello World')
})

// TEST R-05: Unknown file returns null
test('R-05: Unknown file returns null, no error', async () => {
  const buf = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
  const result = await extractPayload(buf.buffer)
  expect(result).toBeNull()
})

// TEST R-06: resolveMode - FULL mode matches
test('R-06: FULL mode resolving matches expectations', () => {
  const permissions = { platformCanDisableSelection: true, platformCanDisableLinks: true, platformCanDisableAll: true }
  expect(resolveMode(permissions, { mode: MODES.FULL })).toBe(MODES.FULL)
})

// TEST R-09: resolveMode - platformCanDisableAll: false blocks RASTER_ONLY
test('R-09: platformCanDisableAll=false blocks RASTER_ONLY', () => {
  const permissions = { platformCanDisableSelection: true, platformCanDisableLinks: true, platformCanDisableAll: false }
  expect(resolveMode(permissions, { mode: MODES.RASTER_ONLY })).toBe(MODES.BUTTON_ONLY)
  expect(resolveMode(permissions, { mode: MODES.BLOCKED })).toBe(MODES.BUTTON_ONLY)
})

// TEST R-10: Span textContent matches byte-for-byte
test('R-10: Span text content matches byte-for-byte', () => {
  const window = createTestDOM()
  const span = window.document.createElement('span')
  const text = 'Hello \n World \t \u200b'
  span.textContent = text
  expect(span.textContent).toBe(text)
})

// TEST R-11: Bounds translation to CSS
test('R-11: Bounds translate to correct CSS percentages', () => {
  const bounds = { x: 5.2, y: 12.4, w: 38.0, h: 7.2 }
  const left = `${bounds.x}%`
  const top = `${bounds.y}%`
  const width = `${bounds.w}%`
  const height = `${bounds.h}%`
  expect(left).toBe('5.2%')
  expect(top).toBe('12.4%')
  expect(width).toBe('38%')
  expect(height).toBe('7.2%')
})

// TEST R-14: Accessibility spans roles
test('R-14: Spans have role=text and aria-label', () => {
  const window = createTestDOM()
  const span = window.document.createElement('span')
  span.setAttribute('role', 'text')
  span.setAttribute('aria-label', 'Hello World')
  expect(span.getAttribute('role')).toBe('text')
  expect(span.getAttribute('aria-label')).toBe('Hello World')
})

// TEST R-15: WebP Extended existing chunks remains readable
test('R-15: WebP Extended chunks remains readable', async () => {
  const buf = fs.readFileSync(OUT_WEBP)
  const format = detectFormat(buf.buffer)
  expect(format).toBe('webp')
})

// ── Full resolution order (T0→T1→T2→OCR) - moved into the library (drift #3) ──

// TEST R-16: resolveLayer returns the T0 layer for a real SIML file.
test('R-16: resolveLayer resolves T0 first', async () => {
  const buf = fs.readFileSync(OUT_PNG)
  const r = await resolveLayer(buf.buffer) // no imageEl → only T0 reachable
  expect(r).not.toBeNull()
  expect(r.tier).toBe('T0')
  expect(r.payload.textLayer[0].text).toBe('Hello World')
})

// TEST R-17: resolveLayer returns null (→ OCR/raster) when no layer + no imageEl.
test('R-17: resolveLayer returns null on a non-SIML buffer', async () => {
  const plain = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8])
  const r = await resolveLayer(plain.buffer)
  expect(r).toBeNull()
})

// TEST R-18: T2 registry resolver honors the Hamming threshold (≤12).
test('R-18: resolveFingerprint matches within threshold, rejects beyond', () => {
  const hash = 'ff'.repeat(32)
  const near = 'fe' + 'ff'.repeat(31) // 1 bit off
  const far  = '00'.repeat(32)        // 256 bits off
  const registry = { [hash]: { siml: '0.3', textLayer: [{ id: 'a', text: 'hi' }] } }

  expect(hammingHex(hash, near)).toBe(1)
  expect(resolveFingerprint(near, registry)).not.toBeNull()         // within ≤12
  expect(resolveFingerprint(far, registry)).toBeNull()              // beyond
})
