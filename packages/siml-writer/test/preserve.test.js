// preserve.test.js - Level-P hook (P-01..) - verified port + package wrapper.
const path = require('path')
const fs = require('fs')
const sharp = require('sharp')
const { write, preserveLayer } = require('../src/index')
const preserve = require('../src/preserve')
const { extractPayload } = require('../../siml-reader/src/extract')

jest.setTimeout(60000) // T1 embedding runs 3 refinement passes; slow under parallel load

// Isolated base image inside our own output dir - must NOT share/touch the
// fixtures/ dir that writer.test.js owns and deletes (parallel-worker race).
const OUTPUT_DIR = path.join(__dirname, 'output-preserve')
const SAMPLE_PNG = path.join(OUTPUT_DIR, 'base-source.png')

const definition = {
  contentId: 'preserve-test',
  permissions: { platformCanDisableSelection: true, platformCanDisableLinks: true, platformCanDisableAll: false },
  textLayer: [
    { id: 'p', text: '+91 98765 43210', type: 'phone', intent: 'actionable', primary: true,
      bounds: { x: 5, y: 10, w: 40, h: 8 }, selectable: true, label: 'Call' },
  ],
}

async function readerSees(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const r = await extractPayload(ab)
  return r && r.payload ? r.payload.textLayer.length : null
}

beforeAll(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  const baseImg = path.join(__dirname, '../../../AA24z3le.png')
  if (fs.existsSync(baseImg)) {
    fs.copyFileSync(baseImg, SAMPLE_PNG)
  } else {
    // No local base image (CI): fall back to the committed real photo
    // fixture the conformance suite already validates against.
    await sharp(path.join(__dirname, '../scripts/sample_bg.png')).png().toFile(SAMPLE_PNG)
  }
})

afterAll(() => {
  try { fs.rmSync(OUTPUT_DIR, { recursive: true, force: true }) } catch {}
})

// Build a real SIML carrier in `fmt`, return its bytes. The writer embeds into a
// carrier of the matching format, so first transcode the base image to `fmt`.
// Unique filenames per call so parallel tests don't race on shared paths.
let mkSeq = 0
async function makeCarrier(fmt) {
  const ext = fmt === 'jpeg' ? 'jpg' : fmt
  const tag = `${fmt}-${process.pid}-${mkSeq++}`
  const baseInFmt = path.join(OUTPUT_DIR, `base.${tag}.${ext}`)
  let img = sharp(SAMPLE_PNG)
  if (fmt === 'jpeg') img = img.jpeg()
  else if (fmt === 'webp') img = img.webp()
  else img = img.png()
  await img.toFile(baseInFmt)

  const out = path.join(OUTPUT_DIR, `src.${tag}.${ext}`)
  await write({ imagePath: baseInFmt, definition, outputPath: out, format: fmt })
  return fs.readFileSync(out)
}

// P-01: same-format re-encode strips the layer; preserveLayer restores a readable one.
for (const [fmt, reencode] of [
  ['png', (b) => sharp(b).png({ compressionLevel: 9 }).toBuffer()],
  ['webp', (b) => sharp(b).webp({ quality: 50 }).toBuffer()],
  ['jpeg', (b) => sharp(b).jpeg({ quality: 50 }).toBuffer()],
]) {
  test(`P-01[${fmt}]: re-encode strips layer; preserveLayer restores a reader-parseable one`, async () => {
    if (!fs.existsSync(SAMPLE_PNG)) return
    const src = await makeCarrier(fmt)
    expect(await readerSees(src)).toBe(1)

    const reenc = await reencode(src)
    expect(preserve.hasLayer(reenc)).toBe(false) // re-encode stripped it

    const restored = await preserveLayer(src, reenc)
    expect(await readerSees(restored)).toBe(1)   // and it's readable again
  })
}

// P-04: CROSS-FORMAT → JPEG. A PNG/WebP source preserved onto a JPEG output must
// produce the canonical JP02+index framing (drift #6 fix), reader-parseable.
for (const srcFmt of ['png', 'webp', 'jpeg']) {
  test(`P-04[${srcFmt}→jpeg]: cross-format preserve re-frames to canonical JPEG`, async () => {
    if (!fs.existsSync(SAMPLE_PNG)) return
    const src = await makeCarrier(srcFmt)
    expect(await readerSees(src)).toBe(1)

    // A fresh JPEG output with no layer (re-encoded from the base image)
    const jpegOut = await sharp(SAMPLE_PNG).jpeg({ quality: 70 }).toBuffer()
    expect(preserve.hasLayer(jpegOut)).toBe(false)

    const restored = await preserveLayer(src, jpegOut)
    expect(await readerSees(restored)).toBe(1) // canonical framing → reader parses

    // And the inserted APP11 carries the JP02 signature (not bare-UUID).
    const i = restored.indexOf(Buffer.from('JP02'))
    expect(i).toBeGreaterThan(0)
  })
}

// P-02: no source layer → output returned unchanged (never breaks the pipeline).
test('P-02: preserveLayer is a no-op when the source has no SIML layer', async () => {
  if (!fs.existsSync(SAMPLE_PNG)) return
  const plain = await sharp(SAMPLE_PNG).png().toBuffer()
  const out = await sharp(SAMPLE_PNG).jpeg().toBuffer()
  const result = await preserveLayer(plain, out)
  expect(result.length).toBe(out.length)
})

// P-03: malformed source must not throw (host pipeline safety).
test('P-03: malformed input is safe (returns output, no throw)', async () => {
  const garbage = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  const out = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  const result = await preserveLayer(garbage, out)
  expect(Buffer.isBuffer(result)).toBe(true)
})
