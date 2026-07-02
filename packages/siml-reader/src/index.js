// src/index.js
const { resolveLayer } = require('./resolve')
const { resolveMode, MODES } = require('./permissions')
const { buildContainer } = require('./render')
const { injectStyles } = require('./copy-ui')

// Load an <img> from bytes so the pixel tiers (T1/T2) can use a canvas.
function loadImageEl(buffer, mime) {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') return resolve(null)
    const blob = new Blob([buffer], { type: mime || 'image/png' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

class SIMLReader {
  constructor(options = {}) {
    this.platformConfig = { mode: options.mode || MODES.FULL }
    this.selector = options.selector || 'img[src$=".png"],img[src$=".jpg"],img[src$=".jpeg"],img[src$=".webp"],img[src$=".siml"]'
    // T2 registry: a plain { hashHex: payload } map or an async lookup(dhash) fn.
    this.registry = options.registry || null
    this.lookup = options.lookup || null
  }

  async init() {
    injectStyles()
    const els = document.querySelectorAll(this.selector)
    await Promise.all([...els].map(el => this.renderElement(el)))
  }

  // Resolve a layer through the full T0→T1→T2→OCR order and build a container,
  // or null if nothing resolved (caller leaves the raster untouched).
  async resolve(buffer, mime, originalEl) {
    const imageEl = await loadImageEl(buffer, mime)
    const resolved = await resolveLayer(buffer, {
      imageEl, registry: this.registry, lookup: this.lookup,
    })
    if (!resolved) return null
    const extracted = {
      payload: resolved.payload,
      imageBytes: resolved.imageBytes || buffer,
      imageMime: resolved.imageMime || mime || 'image/png',
      stale: !!resolved.stale, // spec §9.3: layer doesn't match delivered pixels
    }
    const mode = resolveMode(resolved.payload.permissions, this.platformConfig)
    const container = buildContainer(extracted, mode, originalEl)
    container.dataset.simlTier = resolved.tier
    if (resolved.stale) container.dataset.simlStale = 'true'
    return container
  }

  async renderElement(el) {
    const src = el.src || el.dataset.siml
    if (!src) return
    try {
      const resp = await fetch(src)
      if (!resp.ok) return
      const buffer = await resp.arrayBuffer()
      const mime = resp.headers.get('content-type') || undefined
      const container = await this.resolve(buffer, mime, el)
      if (container && el.parentNode) el.parentNode.replaceChild(container, el)
    } catch (e) {
      console.warn('[siml-reader]', e.message)
    }
  }

  async renderURL(url, targetEl) {
    const resp = await fetch(url)
    const buffer = await resp.arrayBuffer()
    const mime = resp.headers.get('content-type') || undefined
    const container = await this.resolve(buffer, mime, targetEl)
    if (!container) throw new Error('No SIML layer found')
    if (targetEl && targetEl.parentNode) targetEl.parentNode.replaceChild(container, targetEl)
    return container
  }
}

if (typeof window !== 'undefined' && window.SIML_AUTO_INIT !== false) {
  window.SIMLReader = SIMLReader
  window.SIML_MODES = MODES
  document.addEventListener('DOMContentLoaded', () => new SIMLReader().init())
}

module.exports = { SIMLReader, MODES, resolveLayer }
