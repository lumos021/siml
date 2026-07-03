// scripts/make-samples.js - Regenerate real SIML sample images for the demo
// viewer, with current T0 (JUMBF) + T1 (CRC watermark) + T2 (pHash registry).
// Output goes to packages/siml-demo/public as test.siml.{png,jpg,webp}.
//
//   node packages/siml-writer/scripts/make-samples.js

const path = require('path')
const fs = require('fs')
const sharp = require('sharp')
const { write } = require('../src/index')

const DEMO_PUBLIC = path.resolve(__dirname, '../../siml-demo/public')
const TMP = path.resolve(__dirname, '../.sample-tmp')

// A banner-like base (1024×512, the canonical watermark width) with the same
// text the layer declares, so the visible glyphs match the recoverable layer
// (anti-cloaking: rendered SHOULD match raster, spec §9.2.4).
// Single source of truth: each line drives BOTH the burned glyphs and the bounds,
// so the selectable overlay lands exactly on the pixels (no ghosting/offset).
//
// Alignment contract (must match the viewer's overlay model in app/view/page.tsx):
//   • origin TOP-LEFT (SIML bounds are top-left). We draw with the SVG baseline at
//     top + RENDER, so the glyph box top sits at `top`.
//   • the burned string == the layer's `text` (no "Call:" prefix divergence).
//   • the viewer renders the overlay at `style.size * 1.5` px (the editor's stored-
//     pt → drawn-px convention). So we BURN at `size * 1.5` px too, and set the
//     bounds height to that, so overlay glyphs and baked glyphs are the same size.
//   • MONOSPACE → deterministic advance (~0.6·renderPx/char), so Node computes the
//     width and box-fit has nothing to stretch (overlay width == glyph width).
const W = 1024, H = 512
const X = 64               // left margin (px)
const ADV = 0.6            // monospace advance ratio (width per char ≈ 0.6·renderPx)
const MUL = 1.5            // viewer's style.size → rendered px multiplier
const MONO = 'Courier New, Courier, monospace'

// `size` is the stored pt; rendered/burned px = size * MUL.
const LINES = [
  { id: 's1', top: 60,  size: 15, weight: 'regular', color: '#D8C7FF', type: 'text',    intent: 'auto',       label: null,          text: 'ACME DESIGN STUDIO - PROMO' },
  { id: 's2', top: 110, size: 30, weight: 'bold',    color: '#FFFFFF', type: 'text',    intent: 'auto',       label: null,          text: 'Creative Layouts & Graphics' },
  { id: 's3', top: 230, size: 20, weight: 'medium',  color: '#FFE6C2', type: 'phone',   intent: 'actionable', label: 'Call support', text: '+91 98765 43210', primary: true },
  { id: 's4', top: 300, size: 17, weight: 'regular', color: '#C6E8FF', type: 'url',     intent: 'actionable', label: 'Visit site',  text: 'https://siml-spec.org' },
  { id: 's5', top: 365, size: 15, weight: 'regular', color: '#BFE9D4', type: 'address', intent: 'readonly',   label: 'HQ Address',  text: '123 Demo Street, Suite 456, SF' },
]

function escapeXml(s) {
  return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

async function makeBaseImage(outPath) {
  const texts = LINES.map(l => {
    const px = l.size * MUL
    return `<text x="${X}" y="${l.top + px * 0.82}" font-family="${MONO}" font-weight="${l.weight === 'bold' ? 700 : l.weight === 'medium' ? 600 : 400}" font-size="${px}" fill="${l.color}" xml:space="preserve">${escapeXml(l.text)}</text>`
  }).join('\n    ')
  const svg = `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    ${texts}
  </svg>`
  await sharp(path.resolve(__dirname, 'sample_bg.png'))
    .resize(W, H)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toFile(outPath)
}

// Bounds DERIVED from the same geometry - top-left origin, width from the mono
// advance at rendered px, height = rendered px. This is what makes overlay == pixels.
const definition = {
  contentId: 'siml-sample-banner',
  permissions: {
    platformCanDisableSelection: true,
    platformCanDisableLinks: true,
    platformCanDisableAll: false,
  },
  textLayer: LINES.map(l => {
    const px = l.size * MUL
    return {
      id: l.id,
      text: l.text,
      type: l.type,
      intent: l.intent,
      ...(l.primary ? { primary: true } : {}),
      bounds: {
        x: X,
        y: l.top,
        w: Math.round(l.text.length * px * ADV),
        h: Math.round(px),
      },
      selectable: true,
      label: l.label,
      style: { font: MONO, size: l.size, weight: l.weight, color: l.color },
    }
  }),
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true })
  const basePng = path.join(TMP, 'base.png')
  await makeBaseImage(basePng)

  const targets = [
    { format: 'png',  out: path.join(DEMO_PUBLIC, 'test.siml.png') },
    { format: 'jpeg', out: path.join(DEMO_PUBLIC, 'test.siml.jpg') },
    { format: 'webp', out: path.join(DEMO_PUBLIC, 'test.siml.webp') },
  ]

  for (const t of targets) {
    const res = await write({
      imagePath: basePng,
      definition,
      outputPath: t.out,
      format: t.format,
      embedWatermark: true,   // T1
      registerLocal: true,    // T2 (writes siml-registry.json next to output)
    })
    console.log(`✓ ${path.basename(t.out)}  (${(res.size / 1024).toFixed(1)} KB)  dhash=${res.dhash?.slice(0, 12)}…`)
  }

  // Merge stray entries into the central registry database at packages/siml-demo/.siml-registry.json
  const stray = path.join(DEMO_PUBLIC, 'siml-registry.json')
  const dbPath = path.resolve(__dirname, '../../siml-demo/.siml-registry.json')
  // Also write the committed seed the /api/registry route bundles, so the
  // deployed demo resolves the samples via T2 out of the box.
  const seedPath = path.resolve(__dirname, '../../siml-demo/seed-registry.json')
  if (fs.existsSync(stray)) {
    let strayEntries = {}
    try { strayEntries = JSON.parse(fs.readFileSync(stray, 'utf8')) } catch (e) {}
    
    let db = {}
    if (fs.existsSync(dbPath)) {
      try { db = JSON.parse(fs.readFileSync(dbPath, 'utf8')) } catch (e) {}
    }
    
    Object.assign(db, strayEntries)
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2))
    fs.writeFileSync(seedPath, JSON.stringify(db, null, 2))
    console.log(`✓ Registered ${Object.keys(strayEntries).length} fingerprints to ${path.basename(dbPath)}`)
    fs.unlinkSync(stray)
  }

  fs.rmSync(TMP, { recursive: true, force: true })
  console.log('Done. Samples written to packages/siml-demo/public/.')
}

main().catch(e => { console.error(e); process.exit(1) })
