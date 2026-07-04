// SIML Export - Figma plugin main thread.
// Collects the selected frame's text nodes (real geometry, straight from the
// design), exports the raster, and hands both to the UI iframe, which embeds
// the SIML tiers (T0 JUMBF + T1 dual-band watermark + T2 registration) and
// triggers the download.

figma.showUI(__html__, { width: 400, height: 560 })

const ACTIONABLE = { phone: 1, url: 1, email: 1, address: 1 }

function inferType (text) {
  const t = text.trim()
  if (/^[+()\d][\d\s\-().]{6,}$/.test(t) && (t.match(/\d/g) || []).length >= 7) return 'phone'
  if (/^(https?:\/\/|www\.)\S+$/i.test(t)) return 'url'
  if (/^\S+@\S+\.\S+$/.test(t)) return 'email'
  return 'text'
}

async function run () {
  const sel = figma.currentPage.selection
  if (sel.length !== 1 || !('findAll' in sel[0])) {
    figma.ui.postMessage({ type: 'error', message: 'Select exactly one frame, group, or component.' })
    return
  }
  const node = sel[0]
  const box = node.absoluteBoundingBox
  if (!box || box.width < 64 || box.height < 64) {
    figma.ui.postMessage({ type: 'error', message: 'Selection has no size (or is too small).' })
    return
  }

  // Text layer straight from the design: exact strings, exact geometry.
  const texts = node.findAll(n => n.type === 'TEXT' && n.visible && n.characters.trim().length > 0)
  let sawPrimary = false
  const layer = texts.map((t, i) => {
    const b = t.absoluteBoundingBox
    if (!b) return null
    const type = inferType(t.characters)
    // First phone in reading order becomes the watermark-carried primary.
    const primary = !sawPrimary && type === 'phone' ? (sawPrimary = true) : false
    return {
      id: 't' + (i + 1),
      text: t.characters,
      type,
      intent: ACTIONABLE[type] ? 'actionable' : 'auto',
      primary: primary || undefined,
      bounds: {
        x: +(100 * (b.x - box.x) / box.width).toFixed(2),
        y: +(100 * (b.y - box.y) / box.height).toFixed(2),
        w: +(100 * b.width / box.width).toFixed(2),
        h: +(100 * b.height / box.height).toFixed(2),
      },
      fontSize: typeof t.fontSize === 'number' ? t.fontSize : 16,
      selectable: true,
      label: null,
    }
  }).filter(Boolean)

  // Sort into reading order (top-to-bottom, then left-to-right).
  layer.sort((a, b) => (a.bounds.y - b.bounds.y) || (a.bounds.x - b.bounds.x))

  const png = await node.exportAsync({ format: 'PNG', constraint: { type: 'WIDTH', value: 1024 } })
  figma.ui.postMessage({ type: 'export', png, layer, name: node.name.replace(/[^\w\-]+/g, '-') })
}

figma.ui.onmessage = (msg) => {
  if (msg.type === 'run') run()
  if (msg.type === 'notify') figma.notify(msg.message)
  if (msg.type === 'close') figma.closePlugin()
}
