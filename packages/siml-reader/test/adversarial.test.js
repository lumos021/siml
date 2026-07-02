// adversarial.test.js - §7.1 adversarial probes against the reader / renderer /
// action-handler. Every probe asserts a security property: no cloaking, no scheme
// bypass, no clickjacking, no crash/no-act on malformed or oversized input.
//
// Result table is printed at the end (one row per probe → PASS/FAIL).
if (typeof global.TextEncoder === 'undefined') {
  const { TextEncoder, TextDecoder } = require('util')
  global.TextEncoder = TextEncoder
  global.TextDecoder = TextDecoder
}
const { JSDOM } = require('jsdom')
const { actionFor, isActionEnabled, actOn } = require('../src/copy-ui')
const { extractPayload } = require('../src/extract')
const { resolveLayer } = require('../src/resolve')

const results = []
function probe(name, fn) {
  test(name, async () => {
    let pass = false
    try { await fn(); pass = true } finally { results.push({ name, pass }) }
    expect(pass).toBe(true)
  })
}

// ── 1. Scheme bypass (§9.2.3) - actionFor MUST reject unsafe schemes for url ──
probe('A-01 url javascript: scheme rejected', () => {
  expect(actionFor('url', 'javascript:alert(1)')).toBeNull()
})
probe('A-02 url data: scheme rejected', () => {
  expect(actionFor('url', 'data:text/html,<script>alert(1)</script>')).toBeNull()
})
probe('A-03 url file: scheme rejected', () => {
  expect(actionFor('url', 'file:///etc/passwd')).toBeNull()
})
probe('A-04 case/space-obfuscated javascript: rejected', () => {
  expect(actionFor('url', '  JaVaScRiPt:alert(1)')).toBeNull()
})
probe('A-05 http downgraded to https (no cleartext)', () => {
  const a = actionFor('url', 'http://example.com')
  expect(a.scheme.startsWith('https://')).toBe(true)
})
probe('A-06 bare host gets https prefix (not left scheme-less)', () => {
  expect(actionFor('url', 'example.com').scheme).toBe('https://example.com')
})
probe('A-07 phone strips to dial-safe chars only', () => {
  // injection chars in a phone must not survive into the tel: URI
  const a = actionFor('phone', '+1 (800) 555\nrm -rf; <script>')
  expect(/^tel:\+?[0-9]+$/.test(a.scheme)).toBe(true)
})

// ── 2. Action authority / cloaking (§8.1, §9.2) ──
probe('A-08 readonly intent suppresses the action', () => {
  expect(isActionEnabled({ type: 'phone', text: '+19998887777', intent: 'readonly' })).toBe(false)
})
probe('A-09 unsafe-scheme url is not action-enabled', () => {
  expect(isActionEnabled({ type: 'url', text: 'javascript:alert(1)' })).toBe(false)
})
probe('A-10 non-actionable type is not action-enabled', () => {
  expect(isActionEnabled({ type: 'text', text: 'hello' })).toBe(false)
})
probe('A-11 actOn never auto-navigates without confirm', () => {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://host.test/' })
  const w = dom.window
  let navigated = false
  w.confirm = () => false            // user DECLINES
  w.open = () => { navigated = true; return null }
  Object.defineProperty(w, 'location', { value: { set href(v) { navigated = true } }, configurable: true })
  const g = global.window; global.window = w
  try { actOn({ type: 'url', text: 'https://evil.test' }) } finally { global.window = g }
  expect(navigated).toBe(false)
})
probe('A-12 actOn on a declined unsafe scheme does nothing', () => {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://host.test/' })
  const w = dom.window
  let navigated = false
  w.confirm = () => true             // even if user CONFIRMS,
  w.open = () => { navigated = true; return null }
  const g = global.window; global.window = w
  try { actOn({ type: 'url', text: 'javascript:alert(1)' }) } finally { global.window = g }
  expect(navigated).toBe(false)     // unsafe scheme yields no action at all
})

// ── 3. Malformed / oversized payload → no crash, returns null (graceful) ──
probe('A-13 truncated PNG returns null (no throw)', async () => {
  const buf = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).buffer
  expect(await extractPayload(buf)).toBeNull()
})
probe('A-14 garbage bytes return null (no throw)', async () => {
  expect(await extractPayload(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]).buffer)).toBeNull()
})
probe('A-15 PNG with siMl chunk claiming huge length does not hang/crash', async () => {
  // Forge: PNG sig + a siMl chunk header claiming 0x7fffffff bytes of data.
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const len = [0x7f, 0xff, 0xff, 0xff]
  const typ = [0x73, 0x69, 0x4d, 0x6c] // siMl
  const buf = new Uint8Array([...sig, ...len, ...typ, 0, 0, 0, 0]).buffer
  expect(await extractPayload(buf)).toBeNull() // bounds/cap guard → null, no OOM
})
probe('A-16 resolveLayer on junk returns null, never throws', async () => {
  expect(await resolveLayer(new Uint8Array([1, 2, 3, 4]).buffer)).toBeNull()
})

// ── 4. Clickjacking / overflow spans - out-of-range bounds must not be actioned
//     as if valid; the digest/validation layer is upstream, but the action gate
//     itself must still refuse unsafe values regardless of geometry. ──
probe('A-17 oversized text value still yields a safe (or no) action', () => {
  const huge = 'https://' + 'a'.repeat(100000) + '.com'
  const a = actionFor('url', huge)
  // Either a safe https action or null - never an unsafe scheme.
  if (a) expect(a.scheme.startsWith('https://')).toBe(true)
})

afterAll(() => {
  const rows = results.map(r => `  ${r.pass ? '✅ PASS' : '❌ FAIL'}  ${r.name}`).join('\n')
  // eslint-disable-next-line no-console
  console.log(`\n── §7.1 Adversarial probe results ──\n${rows}\n`)
})
