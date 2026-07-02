// src/permissions.js
const MODES = { FULL:'full', BUTTON_ONLY:'button_only', RASTER_ONLY:'raster_only', BLOCKED:'blocked' }

function resolveMode(permissions, platformConfig = {}) {
  const requested = platformConfig.mode || MODES.FULL
  const p = permissions

  // Creator blocked platform from disabling entirely
  if (p && !p.platformCanDisableAll) {
    if (requested === MODES.RASTER_ONLY || requested === MODES.BLOCKED)
      return MODES.BUTTON_ONLY
  }
  return requested
}

module.exports = { MODES, resolveMode }
