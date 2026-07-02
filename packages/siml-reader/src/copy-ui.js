// src/copy-ui.js

// Anti-cloaking (spec §9.2): for actionable types the rendered text may have
// no visible twin, so the literal target MUST be surfaced before any action.
// We never auto-execute (dial/open/navigate) - we reveal-and-confirm first.
const ACTIONABLE_TYPES = new Set(['url', 'phone', 'email', 'address'])

function revealBeforeAct(obj) {
  if (!ACTIONABLE_TYPES.has(obj.type)) return true
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true
  return window.confirm(`This image wants to share a ${obj.type}:\n\n${obj.text}\n\nCopy it?`)
}

// §9.2.3 safe scheme allow-list. Anything outside this set (javascript:, data:,
// file:, …) is rejected so a cloaked payload can't smuggle code into window.open.
// `http:` is allowed through the gate because actionFor() immediately upgrades it
// to https: - a legitimate cleartext link must still produce a (secured) action,
// not be silently dropped.
const SAFE_SCHEMES = ['https:', 'http:', 'tel:', 'mailto:', 'geo:']

function isSafeScheme(url) {
  const m = /^([a-z][a-z0-9+.-]*:)/i.exec(String(url).trim())
  // No scheme → we will prepend https:// ourselves, so it's safe.
  if (!m) return true
  return SAFE_SCHEMES.includes(m[1].toLowerCase())
}

// Map a typed value to the OS URL scheme that routes it. Native scheme semantics
// handle the platform (dialer/mail/maps/browser) - we only hand off the URL.
// Returns null when the value can't be safely actioned (§9.2.3).
function actionFor(type, text) {
  switch (type) {
    case 'phone':   return { scheme: `tel:${String(text).replace(/[^+\d]/g, '')}`, verb: 'Call' }
    case 'email':   return { scheme: `mailto:${String(text).trim()}`, verb: 'Email' }
    case 'url': {
      if (!isSafeScheme(text)) return null // reject javascript:/data:/file:/…
      const scheme = /^https?:\/\//i.test(text) ? text : `https://${text}`
      // Force http→https; only https is on the allow-list for web.
      return { scheme: scheme.replace(/^http:\/\//i, 'https://'), verb: 'Open' }
    }
    case 'address': return { scheme: `https://maps.google.com/?q=${encodeURIComponent(text)}`, verb: 'Directions' }
    default:        return null
  }
}

// §8.1 authority order: permissions (MUST) → platform → intent (SHOULD).
// An action is offered only when: the type is actionable, the platform hasn't
// disabled links, the author's intent isn't 'readonly', and the value yields a
// safe scheme. `intent` defaults to 'actionable' (spec §8).
function isActionEnabled(obj, permissions, platformDisablesLinks = false) {
  if (!obj || !ACTIONABLE_TYPES.has(obj.type)) return false
  if (permissions && permissions.platformCanDisableLinks && platformDisablesLinks) return false
  const intent = obj.intent || 'actionable'
  if (intent === 'readonly') return false
  return actionFor(obj.type, obj.text) !== null
}

// Reveal-then-act: surface the literal target AND destination, navigate only on
// explicit confirm. Never silently fire tel:/mailto:/http (spec §9.2).
function actOn(obj) {
  const action = actionFor(obj.type, obj.text)
  if (!action) return
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return
  const ok = window.confirm(
    `${action.verb} this ${obj.type}?\n\nShown: ${obj.text}\nWill open: ${action.scheme}\n\n` +
    `⚠ The image's hidden text may differ from what you see.`
  )
  if (!ok) return
  if (action.scheme.startsWith('http')) {
    window.open(action.scheme, '_blank', 'noopener,noreferrer')
  } else {
    window.location.href = action.scheme
  }
}

function buildCopyMenu(textLayer, container, permissions) {
  const menu = document.createElement('div')
  menu.className = 'siml-copy-menu'
  menu.style.cssText = 'position:absolute;top:8px;right:8px;display:flex;flex-direction:column;gap:4px;z-index:10'

  textLayer.filter(o => o.selectable).forEach(obj => {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:4px'

    // Action button (Call/Open/Email/Directions) - offered only when §8.1 authority
    // (permissions → intent → safe scheme) permits. Its verb + title reveal the
    // literal destination before any tap.
    const action = isActionEnabled(obj, permissions) ? actionFor(obj.type, obj.text) : null
    if (action) {
      const act = document.createElement('button')
      act.className = 'siml-copy-btn siml-action-btn'
      act.textContent = action.verb
      act.setAttribute('aria-label', `${action.verb} ${obj.type}: ${obj.text}`)
      act.setAttribute('title', action.scheme)
      act.addEventListener('click', () => actOn(obj))
      row.appendChild(act)
    }

    const btn = document.createElement('button')
    btn.className = 'siml-copy-btn'
    btn.textContent = obj.label || `Copy ${obj.type}`
    // Expose the literal target to AT/tooltip so it is never hidden behind a label
    btn.setAttribute('aria-label', `Copy ${obj.type}: ${obj.text}`)
    btn.setAttribute('title', obj.text)
    btn.addEventListener('click', async () => {
      if (!revealBeforeAct(obj)) return // user declined after seeing the target
      await navigator.clipboard.writeText(obj.text)
      const orig = btn.textContent
      btn.textContent = '✓ Copied'
      setTimeout(() => { btn.textContent = orig }, 1500)
    })
    row.appendChild(btn)
    menu.appendChild(row)
  })
  container.appendChild(menu)
}

function injectStyles() {
  if (document.getElementById('siml-styles')) return
  const s = document.createElement('style')
  s.id = 'siml-styles'
  s.textContent = `
    .siml-container{position:relative;display:inline-block}
    .siml-raster{display:block;width:100%;height:auto}
    .siml-text-node{position:absolute;color:transparent;background:transparent}
    .siml-copy-btn{background:rgba(0,0,0,.75);color:#fff;border:none;border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer;white-space:nowrap}
    .siml-copy-btn:hover{background:rgba(0,0,0,.9)}
    .siml-action-btn{background:#6c63ff}
    .siml-action-btn:hover{background:#564fd1}
  `
  document.head.appendChild(s)
}

module.exports = { buildCopyMenu, injectStyles, actionFor, actOn, isActionEnabled, ACTIONABLE_TYPES }
