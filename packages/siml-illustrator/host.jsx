// SIML Export - Illustrator host script (ExtendScript).
// Collects visible text frames on the active artboard with exact strings and
// percentage bounds, rasterizes the artboard to a temp PNG near the canonical
// width, and hands both to the CEP panel as a JSON string. ExtendScript has
// no JSON object, so serialization is done by hand below.

function simlEscape(s) {
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i), code = s.charCodeAt(i);
    if (c === '\\') out += '\\\\';
    else if (c === '"') out += '\\"';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\n'; // Illustrator uses \r for line breaks
    else if (c === '\t') out += '\\t';
    else if (code < 0x20 || code > 0x7e) {
      var hex = code.toString(16);
      while (hex.length < 4) hex = '0' + hex;
      out += '\\u' + hex;
    } else out += c;
  }
  return out;
}

function simlRound2(n) {
  return Math.round(n * 100) / 100;
}

// Rasterize the active artboard to a temp PNG. Export pixels = points * scale
// / 100 (Illustrator raster export is 72 dpi at 100%). The panel resamples to
// the exact canonical grid; here we only need to land at or above it.
function simlExportPNG(doc, abWidthPt) {
  var target = 1024;
  var scale = (target / abWidthPt) * 100;
  if (scale < 1) scale = 1;
  if (scale > 776) scale = 776; // Illustrator's raster export ceiling
  var file = new File(Folder.temp.fsName + '/siml_ai_export.png');
  if (file.exists) file.remove();
  var opts = new ExportOptionsPNG24();
  opts.artBoardClipping = true;
  opts.antiAliasing = true;
  opts.transparency = false;
  opts.horizontalScale = scale;
  opts.verticalScale = scale;
  doc.exportFile(file, ExportType.PNG24, opts);
  return file.fsName;
}

// Entry point called from the panel via evalScript. Returns a JSON string:
// { ok, pngPath, frames: [{ text, x, y, w, h }] } with bounds already in
// percentages of the active artboard, origin top-left.
function SIML_collect() {
  try {
    if (app.documents.length === 0) return '{"ok":false,"error":"No document open."}';
    var doc = app.activeDocument;
    var ab = doc.artboards[doc.artboards.getActiveArtboardIndex()];
    var rect = ab.artboardRect; // [left, top, right, bottom], y axis points up
    var abL = rect[0], abT = rect[1], abW = rect[2] - rect[0], abH = rect[1] - rect[3];
    if (abW <= 0 || abH <= 0) return '{"ok":false,"error":"Empty artboard."}';

    var frames = [];
    for (var i = 0; i < doc.textFrames.length; i++) {
      var tf = doc.textFrames[i];
      try {
        if (tf.hidden) continue;
        if (tf.layer && !tf.layer.visible) continue;
        var text = String(tf.contents);
        if (text.replace(/^\s+|\s+$/g, '') === '') continue;
        var gb = tf.geometricBounds; // [left, top, right, bottom], y up
        var cx = (gb[0] + gb[2]) / 2, cy = (gb[1] + gb[3]) / 2;
        if (cx < rect[0] || cx > rect[2] || cy > rect[1] || cy < rect[3]) continue; // off this artboard
        var x = ((gb[0] - abL) / abW) * 100;
        var y = ((abT - gb[1]) / abH) * 100;
        var w = ((gb[2] - gb[0]) / abW) * 100;
        var h = ((gb[1] - gb[3]) / abH) * 100;
        frames.push('{"text":"' + simlEscape(text) + '","x":' + simlRound2(x) +
          ',"y":' + simlRound2(y) + ',"w":' + simlRound2(w) + ',"h":' + simlRound2(h) + '}');
      } catch (frameErr) { /* skip frames that refuse introspection */ }
    }

    var pngPath = simlExportPNG(doc, abW);
    var name = String(doc.name).replace(/\.[^.]*$/, '');
    return '{"ok":true,"pngPath":"' + simlEscape(pngPath) + '","docName":"' + simlEscape(name) +
      '","frames":[' + frames.join(',') + ']}';
  } catch (err) {
    return '{"ok":false,"error":"' + simlEscape(String(err)) + '"}';
  }
}
