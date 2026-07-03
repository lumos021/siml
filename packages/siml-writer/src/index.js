// src/index.js - Public API for siml-writer v0.3
const sharp = require('sharp')
const fs = require('fs')
const path = require('path')
const { validate } = require('./validate')
const { toPercentage } = require('./bounds')
const { embedSIML: embedPNG  } = require('./embed-png')
const { embedSIML: embedJPEG } = require('./embed-jpeg')
const { embedSIML: embedWebP } = require('./embed-webp')
const { embedWatermark, selectT1Payload, CANONICAL_WIDTH } = require('./watermark')
const { calculatePHashFromGreyscale, selectRegionBounds, PH_SIZE } = require('./fingerprint')

/**
 * Region hash (spec §5.3.1): pHash of just the field's %-bounds region, so
 * near-duplicate template images are separable by their distinguishing 5%.
 * Clamps the crop to the image and pads a little so a strip has enough structure.
 *
 * @param {string} imgPath
 * @param {{x:number,y:number,w:number,h:number}} b  %-bounds (0..100)
 * @returns {Promise<string>} 256-bit hex region hash
 */
async function computeRegionHash(imgPath, b) {
  const meta = await sharp(imgPath).metadata()
  const W = meta.width, H = meta.height
  // %-bounds → pixels, with a small margin so tiny strips carry more structure.
  const padX = 2, padY = 4 // percent
  let left = Math.round(((b.x - padX) / 100) * W)
  let top = Math.round(((b.y - padY) / 100) * H)
  let cw = Math.round(((b.w + 2 * padX) / 100) * W)
  let ch = Math.round(((b.h + 2 * padY) / 100) * H)
  left = Math.max(0, Math.min(left, W - 1))
  top = Math.max(0, Math.min(top, H - 1))
  cw = Math.max(1, Math.min(cw, W - left))
  ch = Math.max(1, Math.min(ch, H - top))
  const grey = await sharp(imgPath)
    .extract({ left, top, width: cw, height: ch })
    .resize(PH_SIZE, PH_SIZE, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer()
  return calculatePHashFromGreyscale(grey).toString('hex')
}

/**
 * Write SIML JUMBF metadata and/or watermarks into standard images.
 *
 * @param {Object}  opts
 * @param {string}  opts.imagePath          Absolute path to source image
 * @param {Object}  opts.definition         Text layer definition (validated)
 * @param {string}  opts.outputPath         Absolute output path
 * @param {string}  [opts.format]           'auto'|'png'|'jpeg'|'webp'
 * @param {boolean} [opts.embedWatermark]   Whether to embed T1 pixel watermark
 * @param {boolean} [opts.registerLocal]    Whether to compute and write T2 fingerprint to local registry
 * @returns {Promise<{outputPath, size, dhash?: string}>}
 */
async function write({ imagePath, definition, outputPath, format = 'auto', embedWatermark: writeT1 = false, registerLocal = false }) {
  const meta = await sharp(imagePath).metadata()
  const { format: detectedFormat, orientation } = meta
  const resolvedFormat = format === 'auto' ? detectedFormat : format

  // EXIF orientation must be applied FIRST so bounds (and the watermark grid) are
  // computed against the image as displayed (spec §9, EXIF reference frame). For orientations 5-8
  // width/height swap, so we read dimensions AFTER auto-rotation, and if the source
  // carried a non-trivial orientation we bake it into the carrier (otherwise bounds
  // would be measured in the displayed frame but stored against the raw raster).
  let { width, height } = meta
  let orientedSourcePath = null
  if (typeof orientation === 'number' && orientation > 1) {
    const rotated = sharp(imagePath).rotate() // auto-orient from EXIF
    const info = await rotated.metadata()
    width = info.width
    height = info.height
    const ext = (resolvedFormat === 'jpg' || resolvedFormat === 'jpeg') ? 'jpg' : resolvedFormat
    orientedSourcePath = path.join(path.dirname(outputPath), `temp-oriented-${Date.now()}.${ext}`)
    await sharp(imagePath).rotate().toFile(orientedSourcePath)
    imagePath = orientedSourcePath
  }

  // Convert pixel bounds to percentage
  const textLayer = (definition.textLayer || []).map(obj => ({
    ...obj,
    bounds: obj.bounds ? toPercentage(obj.bounds, width, height) : undefined,
    runs: obj.runs ? obj.runs.map(run => ({
      ...run,
      bounds: run.bounds ? toPercentage(run.bounds, width, height) : undefined,
    })) : undefined
  }))

  const convertedDefinition = {
    ...definition,
    textLayer,
  }

  const errors = validate(convertedDefinition)
  if (errors.length) {
    const err = new Error('SIML validation failed')
    err.errors = errors; err.code = 'SIML_E_003'
    throw err
  }

  // Determine carrier path (handles T1 watermarking temp path)
  let carrierPath = imagePath
  let tempCarrierPath = null
  // base36 keeps the generated id within T1's 16-byte capacity (id-mode fallback)
  const contentId = definition.contentId || `siml-${Date.now().toString(36)}`

  // §4.5.1: select the one field T1 carries (primary → actionable → skip),
  // never truncating. Done before the resize so we can honor "skip T1".
  let t1Selection = null
  if (writeT1) {
    t1Selection = selectT1Payload(textLayer, contentId)
    if (!t1Selection) {
      writeT1 = false // no eligible field → skip T1 (spec §4.5.1), T0/T2 still apply
    }
  }

  if (writeT1) {
    const canonicalHeight = Math.round((height / width) * CANONICAL_WIDTH / 8) * 8
    const { data, info } = await sharp(imagePath)
      .resize(CANONICAL_WIDTH, canonicalHeight)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })

    // Embed the selected payload (already capacity-checked & NUL-padded, never sliced)
    embedWatermark(data, CANONICAL_WIDTH, canonicalHeight, t1Selection.payload)

    // Write the watermarked carrier to a temp file IN THE OUTPUT FORMAT so the
    // downstream embedder (PNG/JPEG/WebP) receives a matching container. Writing
    // it always-PNG previously made T1 + JPEG/WebP output fail ("not a valid …").
    const ext = (resolvedFormat === 'jpg' || resolvedFormat === 'jpeg') ? 'jpg' : resolvedFormat
    tempCarrierPath = path.join(path.dirname(outputPath), `temp-watermarked-${Date.now()}.${ext}`)
    let pipeline = sharp(data, {
      raw: { width: CANONICAL_WIDTH, height: canonicalHeight, channels: 4 },
    })
    if (resolvedFormat === 'jpeg' || resolvedFormat === 'jpg') pipeline = pipeline.jpeg({ quality: 92 })
    else if (resolvedFormat === 'webp') pipeline = pipeline.webp({ quality: 92 })
    else pipeline = pipeline.png()
    await pipeline.toFile(tempCarrierPath)

    carrierPath = tempCarrierPath
  }

  // Calculate T2 perceptual dHash if requested
  let dhashStr = null
  if (registerLocal) {
    const greyBuffer = await sharp(carrierPath)
      .resize(PH_SIZE, PH_SIZE, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer()
    const phash = calculatePHashFromGreyscale(greyBuffer)
    dhashStr = phash.toString('hex')

    // Region hash (spec §5.3.1): fingerprint the distinguishing field's region so
    // near-duplicate template images (same layout, different number) are separable.
    const regionBounds = selectRegionBounds(textLayer)
    const regionHash = regionBounds
      ? await computeRegionHash(carrierPath, regionBounds)
      : null

    // Save to local registry mock (registry.json alongside outputPath)
    const registryPath = path.join(path.dirname(outputPath), 'siml-registry.json')
    let registry = {}
    if (fs.existsSync(registryPath)) {
      try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) } catch (e) {}
    }
    registry[dhashStr] = {
      siml: '0.3',
      contentId,
      permissions: definition.permissions,
      textLayer,
      ...(regionHash ? { regionHash, regionBounds } : {}),
    }
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2))
  }

  // pixelDigest (spec §9.3, MUST): perceptual-tolerant hash of the canonicalized,
  // displayed-orientation luminance of the FINAL carrier (post-T1, since that is
  // what gets delivered). Reuses the pHash machinery. The reader recomputes this
  // from delivered pixels and marks the layer STALE on mismatch, so an edit that
  // re-burns pixels but copies the container forward fails loud instead of lying.
  const digestGrey = await sharp(carrierPath)
    .resize(PH_SIZE, PH_SIZE, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer()
  const pixelDigest = calculatePHashFromGreyscale(digestGrey).toString('hex')

  const payload = {
    siml: '0.3',
    contentId,
    pixelDigest,
    binding: {
      t0: true,
      t1: writeT1,
      t2: registerLocal,
      // For T1, record payloadMode + canonicalWidth (spec §8 binding field)
      ...(writeT1 && t1Selection
        ? { payloadMode: t1Selection.payloadMode, canonicalWidth: CANONICAL_WIDTH }
        : {}),
    },
    image: { width, height },
    permissions: definition.permissions,
    textLayer,
  }

  switch (resolvedFormat) {
    case 'png':
      embedPNG(carrierPath, payload, outputPath)
      break
    case 'jpeg':
    case 'jpg':
      embedJPEG(carrierPath, payload, outputPath)
      break
    case 'webp':
      await embedWebP(carrierPath, payload, outputPath)
      break
    default:
      throw Object.assign(new Error(`Unsupported format: ${resolvedFormat}`), { code: 'SIML_E_002' })
  }

  // Clean up temp watermarked file
  if (tempCarrierPath && fs.existsSync(tempCarrierPath)) {
    try { fs.unlinkSync(tempCarrierPath) } catch (e) {}
  }
  // Clean up the orientation-normalized temp source, if one was created
  if (orientedSourcePath && fs.existsSync(orientedSourcePath)) {
    try { fs.unlinkSync(orientedSourcePath) } catch (e) {}
  }

  const { size } = fs.statSync(outputPath)
  return { outputPath, size, dhash: dhashStr }
}

const { preserveLayer } = require('./preserve-wrapper')

module.exports = { write, preserveLayer, computeRegionHash }
