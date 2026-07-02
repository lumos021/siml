// src/validate.js
//
// `runs` policy (spec drift #4, web-session call): a single run (or no `runs`,
// rendered as one box) is CONFORMANT - it is the correct shape for single-line
// payloads (phone/price/url/coupon), which are the high-value cases. Per-line
// runs are a SHOULD for genuinely multi-line text, deferred until the editor has
// a multi-line model. We therefore do NOT flag single-run; we only sanity-check
// run bounds when present (V-18).
function validate(def) {
  const errors = []

  // V-01
  if (!Array.isArray(def.textLayer))
    errors.push('V-01: textLayer must be an array')

  // V-12
  const p = def.permissions
  if (!p || typeof p.platformCanDisableSelection !== 'boolean' ||
      typeof p.platformCanDisableLinks !== 'boolean' ||
      typeof p.platformCanDisableAll !== 'boolean')
    errors.push('V-12: permissions must have 3 boolean fields')

  if (!Array.isArray(def.textLayer)) return errors

  const ids = new Set()
  def.textLayer.forEach((obj, i) => {
    // V-02
    if (!obj.id || typeof obj.id !== 'string' || obj.id.trim() === '')
      errors.push(`V-02 [${i}]: id must be a non-empty string`)

    // V-03
    if (obj.id) {
      if (ids.has(obj.id)) errors.push(`V-03 [${i}]: duplicate id "${obj.id}"`)
      ids.add(obj.id)
    }

    // V-04
    if (!obj.text || typeof obj.text !== 'string' || obj.text === '')
      errors.push(`V-04 [${i}]: text must be a non-empty string`)

    // V-05: forward-compat - unknown type degrades to 'text' (spec §8), never an
    // error that would drop the layer. Missing type is still a hard error.
    const validTypes = ['phone','email','url','address','text']
    if (obj.type === undefined || obj.type === null || typeof obj.type !== 'string') {
      errors.push(`V-05 [${i}]: type is required`)
    } else if (!validTypes.includes(obj.type)) {
      obj.type = 'text'
    }

    // V-11
    if (typeof obj.selectable !== 'boolean')
      errors.push(`V-11 [${i}]: selectable must be a boolean`)

    // V-16: intent (spec §8.1) - optional; unknown value degrades to default
    // 'actionable' rather than erroring (forward-compat, like type).
    if (obj.intent !== undefined && !['actionable','readonly','auto'].includes(obj.intent))
      obj.intent = 'actionable'

    // V-17: primary (spec §8 / §4.5.1) - optional boolean
    if (obj.primary !== undefined && typeof obj.primary !== 'boolean')
      errors.push(`V-17 [${i}]: primary must be a boolean`)

    // V-18: runs (optional). Single-run is conformant (see header note). When
    // runs ARE present, each must carry valid %-bounds - but we never require
    // more than one.
    if (obj.runs !== undefined) {
      if (!Array.isArray(obj.runs) || obj.runs.length === 0) {
        errors.push(`V-18 [${i}]: runs, when present, must be a non-empty array`)
      } else {
        obj.runs.forEach((run, ri) => {
          const rb = run && run.bounds
          if (!rb || typeof rb.x !== 'number' || typeof rb.y !== 'number' ||
              typeof rb.w !== 'number' || typeof rb.h !== 'number' ||
              rb.x < 0 || rb.y < 0 || rb.w <= 0 || rb.h <= 0 ||
              rb.x + rb.w > 100 || rb.y + rb.h > 100) {
            errors.push(`V-18 [${i}].runs[${ri}]: run bounds out of range`)
          }
        })
      }
    }

    // V-06 through V-10 - only if selectable
    if (obj.selectable && obj.bounds) {
      const { x, y, w, h } = obj.bounds
      if (x < 0 || x > 100) errors.push(`V-07 [${i}]: bounds.x out of range`)
      if (y < 0 || y > 100) errors.push(`V-07 [${i}]: bounds.y out of range`)
      if (w <= 0 || w > 100) errors.push(`V-08 [${i}]: bounds.w out of range`)
      if (h <= 0 || h > 100) errors.push(`V-08 [${i}]: bounds.h out of range`)
      if (x + w > 100) errors.push(`V-09 [${i}]: bounds x+w exceeds 100`)
      if (y + h > 100) errors.push(`V-10 [${i}]: bounds y+h exceeds 100`)
    } else if (obj.selectable && !obj.bounds) {
      errors.push(`V-06 [${i}]: bounds required when selectable is true`)
    }

    // V-13
    if (obj.style?.color && !/^#[0-9A-Fa-f]{6}$/.test(obj.style.color))
      errors.push(`V-13 [${i}]: style.color must be #RRGGBB`)

    // V-14
    if (obj.style?.weight && !['regular','medium','bold'].includes(obj.style.weight))
      errors.push(`V-14 [${i}]: style.weight must be regular|medium|bold`)

    // V-15
    if (obj.style?.align && !['left','center','right'].includes(obj.style.align))
      errors.push(`V-15 [${i}]: style.align must be left|center|right`)
  })

  return errors
}

module.exports = { validate }
