// src/bounds.js
function isPixelMode(bounds) {
  return Object.values(bounds).some(v => Number.isInteger(v) && v > 1)
}

function toPercentage(bounds, imageWidth, imageHeight) {
  if (!isPixelMode(bounds)) return bounds
  return {
    x: parseFloat(((bounds.x / imageWidth)  * 100).toFixed(4)),
    y: parseFloat(((bounds.y / imageHeight) * 100).toFixed(4)),
    w: parseFloat(((bounds.w / imageWidth)  * 100).toFixed(4)),
    h: parseFloat(((bounds.h / imageHeight) * 100).toFixed(4)),
  }
}

module.exports = { isPixelMode, toPercentage }
