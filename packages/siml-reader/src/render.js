// src/render.js - DOM layer builder with runs and box-fitting
const { MODES } = require('./permissions')
const { actOn, isActionEnabled } = require('./copy-ui')

function computeFontSize(pts, imageHeight) {
  if (!pts || !imageHeight) return null
  const px = pts * 1.333 // pt to px at 96dpi
  return `${((px / imageHeight) * 100).toFixed(3)}%`
}

function applyBoxFit(container) {
  const img = container.querySelector('.siml-raster')
  if (!img) return

  const apply = () => {
    const imgWidth = img.clientWidth
    const imgHeight = img.clientHeight
    if (!imgWidth || !imgHeight) return

    const nodes = container.querySelectorAll('.siml-text-node')
    nodes.forEach(node => {
      const wPct = parseFloat(node.dataset.simlW)
      if (isNaN(wPct) || wPct <= 0) return
      
      const targetWidthPx = (wPct / 100) * imgWidth
      
      // Reset transform
      node.style.transform = 'none'
      
      // Measure natural width
      const rect = node.getBoundingClientRect()
      const naturalWidthPx = rect.width
      
      if (naturalWidthPx > 0) {
        const scaleX = targetWidthPx / naturalWidthPx
        node.style.transform = `scaleX(${scaleX.toFixed(4)})`
        node.style.transformOrigin = 'left top'
      }
    })
  }

  if (img.complete) {
    apply()
  } else {
    img.addEventListener('load', apply)
  }

  // Handle updates on resize
  if (typeof window !== 'undefined' && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => apply())
    ro.observe(img)
  }
}

function buildContainer(extracted, mode, originalEl) {
  const { payload, imageBytes, imageMime, stale } = extracted
  const { textLayer } = payload

  const blob = new Blob([imageBytes], { type: imageMime })
  const blobURL = URL.createObjectURL(blob)

  // Wrapper container
  const container = document.createElement('div')
  container.className = 'siml-container'
  container.dataset.simlReady = 'true'

  // Raster image
  const img = document.createElement('img')
  img.className = 'siml-raster'
  img.src = blobURL
  img.draggable = false
  img.onload = () => URL.revokeObjectURL(blobURL)

  // Section 10 Accessibility: empty alt when SIML is present
  const hasTextLayer = textLayer && textLayer.length > 0
  if (hasTextLayer && (mode === MODES.FULL || mode === MODES.BUTTON_ONLY)) {
    img.alt = ''
  } else {
    img.alt = (originalEl && originalEl.alt) || ''
  }
  container.appendChild(img)

  if (hasTextLayer && (mode === MODES.FULL || mode === MODES.BUTTON_ONLY)) {
    // Section 10: Visual reading order sort (y first, then x)
    const sortedObjects = [...textLayer]
      .filter(o => o.selectable !== false)
      .sort((a, b) => {
        const ay = a.bounds?.y || 0
        const by = b.bounds?.y || 0
        if (Math.abs(ay - by) > 1) return ay - by
        return (a.bounds?.x || 0) - (b.bounds?.x || 0)
      })

    sortedObjects.forEach(obj => {
      // Forward-compat (spec §8): degrade an unknown type to 'text' rather than
      // dropping or mislabelling the layer.
      const KNOWN_TYPES = ['phone', 'email', 'url', 'address', 'text']
      const objType = KNOWN_TYPES.includes(obj.type) ? obj.type : 'text'

      // Determine font sizing
      const fontSize = obj.style?.size
        ? computeFontSize(obj.style.size, payload.image?.height)
        : null

      // Check if runs array is present and has elements, else fallback to bounds
      const geometricRuns = (obj.runs && obj.runs.length > 0)
        ? obj.runs.map(r => ({ bounds: r.bounds || r, text: r.text || obj.text }))
        : [{ bounds: obj.bounds, text: obj.text }]

      geometricRuns.forEach((run, index) => {
        const span = document.createElement('span')
        span.className = 'siml-text-node'
        span.dataset.simlId = `${obj.id}-r${index}`
        span.dataset.simlType = objType
        span.dataset.simlW = run.bounds.w
        span.textContent = run.text
        span.setAttribute('aria-label', run.text)
        span.setAttribute('role', 'text')

        // Expose typed description
        if (objType !== 'text') {
          span.setAttribute('aria-description', objType)
        }

        // Reveal-then-act on tap for actionable types (FULL mode only, subject to
        // §8.1 authority: permissions → intent → safe scheme). A plain click acts;
        // an active text selection is left alone so dragging still selects. Never
        // auto-navigates - actOn() confirms the literal target.
        // STALE layers (spec §9.3) suppress ALL typed actions: the text no longer
        // matches the pixels, so it is not authoritative and must not be acted on.
        const actObj = { type: objType, text: obj.text, intent: obj.intent }
        const isActionable = !stale && mode === MODES.FULL && isActionEnabled(actObj, payload.permissions)
        if (stale) span.setAttribute('aria-description', 'unverified (does not match the image)')
        if (isActionable) {
          span.setAttribute('role', 'button')
          span.addEventListener('click', () => {
            const sel = typeof window !== 'undefined' && window.getSelection
              ? window.getSelection().toString() : ''
            if (sel) return
            actOn(actObj)
          })
        }

        span.style.cssText = [
          'position:absolute',
          `left:${run.bounds.x}%`,
          `top:${run.bounds.y}%`,
          `width:${run.bounds.w}%`,
          `height:${run.bounds.h}%`,
          'color:transparent',
          'background:transparent',
          `user-select:${mode === MODES.FULL ? 'text' : 'none'}`,
          `cursor:${isActionable ? 'pointer' : (mode === MODES.FULL ? 'text' : 'default')}`,
          'pointer-events:auto',
          'white-space:nowrap',
          'overflow:hidden',
          obj.style?.font ? `font-family:${obj.style.font},sans-serif` : '',
          fontSize ? `font-size:${fontSize}` : `font-size:${run.bounds.h}%`,
          obj.style?.weight ? `font-weight:${obj.style.weight}` : '',
          obj.style?.italic ? 'font-style:italic' : '',
          obj.style?.letterSpacing ? `letter-spacing:${obj.style.letterSpacing}px` : '',
          obj.style?.lineHeight ? `line-height:${obj.style.lineHeight}px` : '',
        ].filter(Boolean).join(';')

        container.appendChild(span)
      })
    })

    // Apply post-layout box fit calibration
    if (typeof window !== 'undefined') {
      applyBoxFit(container)
    }

    if (mode === MODES.BUTTON_ONLY) {
      const { buildCopyMenu } = require('./copy-ui')
      buildCopyMenu(textLayer, container, payload.permissions)
    }
  }

  return container
}

module.exports = { buildContainer, computeFontSize }
