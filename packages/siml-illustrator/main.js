// SIML Export - Illustrator CEP panel.
// The host script (host.jsx) collects text frames and rasterizes the active
// artboard; this panel resamples to the canonical grid, embeds the SIML tiers
// with the shared engine, and writes the file through a native save dialog
// (cep.fs - no Node.js flag required).
/* global window, document, Image, fetch, TextEncoder */

// ENGINE_START (copied verbatim from packages/siml-photoshop/main.js - keep in sync)
// SIML engine: same math as siml-writer (dual-band QIM, prime-padded
// stream, RS + CRC fail-loud, JUMBF, 5.3.1 region hash), with pure-JS
// resampling replacing the browser canvas.
const T1_CAPACITY = 16;
const SYNC_TAG = 0xd4b3, Q = 26, QIM_MARGIN = 18, RS_NSYM = 4;
const TEXTURE_EMBED_STDDEV = 8, MIN_TEXTURED_REPS = 8, MIN_POSITION_VOTES = 4, Q_SMOOTH = 13;
const PH_SIZE = 32, PH_LOW = 16;
const SIML_UUID = [0xde, 0x60, 0x62, 0xe1, 0x9e, 0x7b, 0x49, 0x4e, 0x94, 0xb3, 0xdb, 0x6f, 0xcc, 0x25, 0x7f, 0xdc];
const ACTIONABLE = new Set(["url", "phone", "email", "address"]);

function nextPrime(n) {
  const isP = (k) => { for (let d = 2; d * d <= k; d++) if (k % d === 0) return false; return k > 1; };
  while (!isP(n)) n++;
  return n;
}

const RS_EXP = new Uint8Array(512), RS_LOG = new Uint8Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { RS_EXP[i] = x; RS_LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; } for (let i = 255; i < 512; i++) RS_EXP[i] = RS_EXP[i - 255]; })();
const rsMul = (a, b) => (a && b ? RS_EXP[RS_LOG[a] + RS_LOG[b]] : 0);

function rsEncode(data, nsym) {
  let g = [1];
  for (let i = 0; i < nsym; i++) {
    const q = [1, RS_EXP[i]], r = new Array(g.length + 1).fill(0);
    for (let a = 0; a < g.length; a++) for (let b = 0; b < 2; b++) r[a + b] ^= rsMul(g[a], q[b]);
    g = r;
  }
  const msg = [...data, ...new Array(nsym).fill(0)];
  for (let i = 0; i < data.length; i++) {
    if (!msg[i]) continue;
    for (let j = 1; j < g.length; j++) msg[i + j] ^= rsMul(g[j], msg[i]);
  }
  return [...data, ...msg.slice(data.length)]; // systematic: ORIGINAL data + parity
}

function crc16(bytes) {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc & 0xffff;
}

const cosT = new Float32Array(64);
for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) cosT[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
const cc = (w) => (w === 0 ? 1 / Math.sqrt(2) : 1);

function dct2d(blk) {
  const out = new Float32Array(64);
  for (let u = 0; u < 8; u++) {
    const cu = cc(u);
    for (let v = 0; v < 8; v++) {
      const cv = cc(v);
      let s = 0;
      for (let x = 0; x < 8; x++) { const cx = cosT[u * 8 + x]; for (let y = 0; y < 8; y++) s += blk[x * 8 + y] * cx * cosT[v * 8 + y]; }
      out[u * 8 + v] = 0.25 * cu * cv * s;
    }
  }
  return out;
}

function idct2d(d) {
  const out = new Float32Array(64);
  for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {
    let s = 0;
    for (let u = 0; u < 8; u++) { const cu = cc(u), cx = cosT[u * 8 + x]; for (let v = 0; v < 8; v++) s += cu * cc(v) * d[u * 8 + v] * cx * cosT[v * 8 + y]; }
    out[x * 8 + y] = 0.25 * s;
  }
  return out;
}

function embedWatermark(rgba, width, height, payloadBytes) {
  const crc = crc16(payloadBytes);
  const rsCoded = rsEncode([...Array.from(payloadBytes), (crc >> 8) & 0xff, crc & 0xff], RS_NSYM);
  const bits = [];
  for (let i = 0; i < 16; i++) bits.push((SYNC_TAG >> (15 - i)) & 1);
  for (const b of rsCoded) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  while (bits.length < nextPrime(bits.length)) bits.push(0); // prime-padded stream

  const bX = Math.floor(width / 8), bY = Math.floor(height / 8);
  const Y0 = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) Y0[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  const mask = new Uint8Array(bX * bY);
  let eligible = 0;
  for (let by = 0; by < bY; by++) for (let bx = 0; bx < bX; bx++) {
    let m = 0;
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) m += Y0[(by * 8 + x) * width + (bx * 8 + y)];
    m /= 64;
    let v = 0;
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) { const d = Y0[(by * 8 + x) * width + (bx * 8 + y)] - m; v += d * d; }
    if (Math.sqrt(v / 64) >= TEXTURE_EMBED_STDDEV) { mask[by * bX + bx] = 1; eligible++; }
  }
  const posVotes = new Uint32Array(bits.length);
  for (let i = 0; i < mask.length; i++) if (mask[i]) posVotes[i % bits.length]++;
  let minVotes = Infinity;
  for (let i = 0; i < bits.length; i++) if (posVotes[i] < minVotes) minVotes = posVotes[i];
  const selective = eligible >= MIN_TEXTURED_REPS * bits.length && minVotes >= MIN_POSITION_VOTES;
  if (!selective) for (let i = 0; i < mask.length; i++) if (!mask[i]) mask[i] = 2; // dual-band

  for (let pass = 0; pass < 3; pass++) {
    const Y = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) Y[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    const blk = new Float32Array(64);
    for (let by = 0; by < bY; by++) for (let bx = 0; bx < bX; bx++) {
      const bi = by * bX + bx, mode = mask[bi];
      if (!mode) continue;
      for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) blk[x * 8 + y] = Y[(by * 8 + x) * width + (bx * 8 + y)];
      const d = dct2d(blk), target = bits[bi % bits.length], c = d[2 * 8 + 1];
      const q = mode === 2 ? Q_SMOOTH : Q;
      let quantum = Math.round(c / q);
      const even = ((quantum % 2) + 2) % 2 === 0;
      if (even !== (target === 0)) quantum += c / q - quantum >= 0 ? 1 : -1;
      const level = quantum * q;
      if (mode === 2) d[2 * 8 + 1] = level;
      else { const band = (Q - QIM_MARGIN) / 2; d[2 * 8 + 1] = level + Math.max(-band, Math.min(band, c - level)); }
      const rec = idct2d(d);
      for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) Y[(by * 8 + x) * width + (bx * 8 + y)] = rec[x * 8 + y];
    }
    for (let i = 0; i < width * height; i++) {
      const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
      const oy = 0.299 * r + 0.587 * g + 0.114 * b, dl = Y[i] - oy;
      rgba[i * 4] = Math.round(Math.max(0, Math.min(255, r + dl)));
      rgba[i * 4 + 1] = Math.round(Math.max(0, Math.min(255, g + dl)));
      rgba[i * 4 + 2] = Math.round(Math.max(0, Math.min(255, b + dl)));
    }
  }
  return { placement: selective ? "textured" : "dual-band" };
}

function selectT1Payload(layer, contentId) {
  const enc = new TextEncoder();
  const fits = (s) => enc.encode(s).length <= T1_CAPACITY;
  const chosen = layer.find((o) => o.primary === true) ||
    layer.find((o) => (o.intent || "actionable") === "actionable" && ACTIONABLE.has(o.type));
  if (!chosen) return null;
  if (fits(chosen.text)) return { value: chosen.text, mode: "direct" };
  if (fits(contentId)) return { value: contentId, mode: "id" };
  const fb = layer.find((o) => o !== chosen && (o.intent || "actionable") === "actionable" && ACTIONABLE.has(o.type) && fits(o.text));
  return fb ? { value: fb.text, mode: "direct" } : null;
}

// Pure-JS resampling for the perceptual hashes (mirrors the canvas pipeline:
// progressive 2x box halving, then box resample to 32x32 greyscale).
function toGrey(rgba, w, h) {
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  return g;
}
function halve(grey, w, h) {
  const nw = Math.ceil(w / 2), nh = Math.ceil(h / 2);
  const out = new Float64Array(nw * nh);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    let s = 0, n = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const sx = x * 2 + dx, sy = y * 2 + dy;
      if (sx < w && sy < h) { s += grey[sy * w + sx]; n++; }
    }
    out[y * nw + x] = s / n;
  }
  return { grey: out, w: nw, h: nh };
}
function resampleTo32(grey, w, h) {
  while (w > 2 * PH_SIZE && h > 2 * PH_SIZE) ({ grey, w, h } = halve(grey, w, h));
  // Final step is a box average per destination cell, the pure-JS analog of
  // the reader's high-quality drawImage to 32x32 (extract.js
  // getPHashFromImageElement) so staleness digests land close across hosts.
  const out = new Float64Array(PH_SIZE * PH_SIZE);
  for (let y = 0; y < PH_SIZE; y++) for (let x = 0; x < PH_SIZE; x++) {
    const x0 = Math.floor((x * w) / PH_SIZE), x1 = Math.max(x0 + 1, Math.ceil(((x + 1) * w) / PH_SIZE));
    const y0 = Math.floor((y * h) / PH_SIZE), y1 = Math.max(y0 + 1, Math.ceil(((y + 1) * h) / PH_SIZE));
    let s = 0, n = 0;
    for (let sy = y0; sy < y1 && sy < h; sy++) for (let sx = x0; sx < x1 && sx < w; sx++) { s += grey[sy * w + sx]; n++; }
    out[y * PH_SIZE + x] = n ? s / n : 0;
  }
  return out;
}
const phB = (() => {
  const b = new Float64Array(PH_SIZE * PH_SIZE);
  for (let u = 0; u < PH_SIZE; u++) for (let x = 0; x < PH_SIZE; x++) b[u * PH_SIZE + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * PH_SIZE));
  return b;
})();
function pHashGrey(grey) {
  const rows = new Float64Array(PH_SIZE * PH_SIZE);
  for (let y = 0; y < PH_SIZE; y++) for (let u = 0; u < PH_SIZE; u++) {
    let s = 0;
    for (let x = 0; x < PH_SIZE; x++) s += grey[y * PH_SIZE + x] * phB[u * PH_SIZE + x];
    rows[y * PH_SIZE + u] = s;
  }
  const d = new Float64Array(PH_SIZE * PH_SIZE);
  for (let u = 0; u < PH_SIZE; u++) for (let v = 0; v < PH_SIZE; v++) {
    let s = 0;
    for (let y = 0; y < PH_SIZE; y++) s += rows[y * PH_SIZE + v] * phB[u * PH_SIZE + y];
    d[u * PH_SIZE + v] = s;
  }
  const co = new Float64Array(PH_LOW * PH_LOW);
  let k = 0;
  for (let u = 0; u < PH_LOW; u++) for (let v = 0; v < PH_LOW; v++) co[k++] = d[u * PH_SIZE + v];
  const sorted = Array.from(co).slice(1).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const hsh = new Uint8Array(32);
  for (let i = 0; i < PH_LOW * PH_LOW; i++) if (co[i] > med) hsh[i >> 3] |= 1 << (7 - (i & 7));
  return Array.from(hsh).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function pHashOfRGBA(rgba, w, h) {
  return pHashGrey(resampleTo32(toGrey(rgba, w, h), w, h));
}
function regionHashOfRGBA(rgba, W, H, b) {
  const padX = 2, padY = 4;
  let left = Math.round(((b.x - padX) / 100) * W), top = Math.round(((b.y - padY) / 100) * H);
  let cw = Math.round(((b.w + 2 * padX) / 100) * W), ch = Math.round(((b.h + 2 * padY) / 100) * H);
  left = Math.max(0, Math.min(left, W - 1)); top = Math.max(0, Math.min(top, H - 1));
  cw = Math.max(1, Math.min(cw, W - left)); ch = Math.max(1, Math.min(ch, H - top));
  const crop = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) for (let c = 0; c < 4; c++)
    crop[(y * cw + x) * 4 + c] = rgba[((top + y) * W + (left + x)) * 4 + c];
  return pHashOfRGBA(crop, cw, ch);
}

// T0 JUMBF + container injection (PNG chunk / JPEG APP11).
const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(bytes) {
  let c = 0 ^ -1;
  for (let i = 0; i < bytes.length; i++) c = (c >>> 8) ^ crcTable[(c ^ bytes[i]) & 0xff];
  return (c ^ -1) >>> 0;
}
function u32(arr, off, val) { arr[off] = (val >>> 24) & 0xff; arr[off + 1] = (val >>> 16) & 0xff; arr[off + 2] = (val >>> 8) & 0xff; arr[off + 3] = val & 0xff; }
function concat(arrs) {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function serializeJUMBF(obj) {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const label = "siml\0";
  const jumbd = new Uint8Array(4 + 4 + 16 + 1 + label.length);
  u32(jumbd, 0, jumbd.length);
  jumbd.set([106, 117, 109, 98, 100], 4);
  jumbd.set(SIML_UUID, 8);
  jumbd[24] = 0x03;
  for (let i = 0; i < label.length; i++) jumbd[25 + i] = label.charCodeAt(i);
  const jbox = new Uint8Array(8 + json.length);
  u32(jbox, 0, jbox.length);
  jbox.set([106, 115, 111, 110], 4);
  jbox.set(json, 8);
  const sup = new Uint8Array(8);
  u32(sup, 0, 8 + jumbd.length + jbox.length);
  sup.set([106, 117, 109, 98], 4);
  return concat([sup, jumbd, jbox]);
}
function injectPNG(buf, payload) {
  const head = new Uint8Array(8);
  u32(head, 0, payload.length);
  head[4] = 115; head[5] = 105; head[6] = 77; head[7] = 108; // siMl
  const td = new Uint8Array(4 + payload.length);
  td.set(head.subarray(4, 8), 0);
  td.set(payload, 4);
  const crc = new Uint8Array(4);
  u32(crc, 0, crc32(td));
  const chunk = concat([head, payload, crc]);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 8;
  while (pos < buf.length) {
    if (pos + 8 > buf.length) break;
    const len = view.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    if (type === "IEND") return concat([buf.subarray(0, pos), chunk, buf.subarray(pos)]);
    pos += 12 + len;
  }
  return concat([buf, chunk]);
}
function injectJPEG(buf, jumbf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("not a valid JPEG");
  const segLen = 2 + 4 + 4 + jumbf.length;
  if (segLen > 0xffff) throw new Error("SIML payload too large for one JPEG APP11 segment");
  const header = new Uint8Array(12);
  header[0] = 0xff; header[1] = 0xeb;
  header[2] = (segLen >>> 8) & 0xff; header[3] = segLen & 0xff;
  header[4] = 0x4a; header[5] = 0x50; header[6] = 0x30; header[7] = 0x32; // JP02
  header[8] = 0; header[9] = 0; header[10] = 0; header[11] = 1;
  const segment = concat([header, jumbf]);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 2, insertAt = -1;
  while (pos < buf.length - 1) {
    if (buf[pos] !== 0xff) break;
    const marker = (buf[pos] << 8) | buf[pos + 1];
    if (marker === 0xffda) { insertAt = pos; break; }
    if (pos + 4 > buf.length) break;
    pos += 2 + dv.getUint16(pos + 2, false);
  }
  if (insertAt === -1) throw new Error("JPEG missing SOS marker");
  return concat([buf.subarray(0, insertAt), segment, buf.subarray(insertAt)]);
}
// ENGINE_END

// Panel logic.
var logEl = document.getElementById("log");
function say(m) { logEl.textContent += "\n" + m; logEl.scrollTop = logEl.scrollHeight; }

function inferType(text) {
  var t = text.trim();
  if (/^[+()\d][\d\s\-().]{6,}$/.test(t) && (t.match(/\d/g) || []).length >= 7) return "phone";
  if (/^(https?:\/\/|www\.)\S+$/i.test(t)) return "url";
  if (/^\S+@\S+\.\S+$/.test(t)) return "email";
  return "text";
}

function evalScript(script) {
  return new Promise(function (resolve, reject) {
    if (!window.__adobe_cep__) { reject(new Error("Not running inside a CEP host.")); return; }
    window.__adobe_cep__.evalScript(script, function (res) {
      if (res === "EvalScript error.") reject(new Error("Host script failed."));
      else resolve(res);
    });
  });
}

function base64ToBytes(b64) {
  var bin = window.atob(b64);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  var CHUNK = 0x8000, parts = [];
  for (var i = 0; i < bytes.length; i += CHUNK)
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
  return window.btoa(parts.join(""));
}

function loadImage(dataUrl) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.onload = function () { resolve(img); };
    img.onerror = function () { reject(new Error("Could not decode the exported raster.")); };
    img.src = dataUrl;
  });
}

async function run() {
  var go = document.getElementById("go");
  go.disabled = true;
  logEl.textContent = "Working...";
  try {
    var format = document.getElementById("format").value || "png";
    var wantT1 = document.getElementById("t1").checked;
    var wantT2 = document.getElementById("t2").checked;
    var registry = document.getElementById("registry").value.trim();

    var raw = await evalScript("SIML_collect()");
    var host = JSON.parse(raw);
    if (!host.ok) { say("Failed: " + host.error); return; }

    // Build the text layer from the host's frames (bounds already in %).
    var layer = host.frames.map(function (f, idx) {
      var type = inferType(f.text);
      return {
        id: "t" + (idx + 1),
        text: f.text,
        type: type,
        intent: ACTIONABLE.has(type) ? "actionable" : "auto",
        bounds: { x: f.x, y: f.y, w: f.w, h: f.h },
      };
    });
    layer.sort(function (a, b) { return a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x; });
    for (var pi = 0; pi < layer.length; pi++) {
      if (layer[pi].type === "phone") { layer[pi].primary = true; break; }
    }
    say("Found " + layer.length + " text frame(s).");
    var phones = layer.filter(function (o) { return o.type === "phone"; });
    if (phones.length > 1) say(phones.length + " phone fields; T1 carries the first in reading order. All fields ride in T0.");

    // Read the artboard raster and resample to the canonical grid.
    var readRes = window.cep.fs.readFile(host.pngPath, window.cep.encoding.Base64);
    if (readRes.err !== 0) { say("Failed: could not read the exported raster (fs err " + readRes.err + ")."); return; }
    var img = await loadImage("data:image/png;base64," + readRes.data);
    var W = 1024;
    var H = Math.max(8, Math.round(((img.naturalHeight / img.naturalWidth) * W) / 8) * 8);
    var canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H); // opaque base so JPEG and the watermark agree
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, W, H);
    var imageData = ctx.getImageData(0, 0, W, H);
    var rgba = imageData.data;

    var contentId = "siml-" + Date.now().toString(36);
    var t1Mode = null, placement = null;
    if (wantT1) {
      var sel = selectT1Payload(layer, contentId);
      if (sel) {
        var p = new Uint8Array(16);
        p.set(new TextEncoder().encode(sel.value));
        var stat = embedWatermark(rgba, W, H, p);
        t1Mode = sel.mode; placement = stat.placement;
        ctx.putImageData(imageData, 0, 0);
      }
    }
    if (wantT1 && t1Mode) say("T1 watermark embedded (" + t1Mode + ", " + placement + " placement).");
    else if (wantT1) say("T1 skipped: no phone/url/email/address field fits 16 bytes. T0 + T2 still carry all text.");

    var pixelDigest = pHashOfRGBA(rgba, W, H);
    var dhash = null, regionInfo = null;
    if (wantT2) {
      dhash = pixelDigest;
      var regionObj = null;
      for (var i = 0; i < layer.length; i++) if (layer[i].primary) { regionObj = layer[i]; break; }
      if (!regionObj) for (var j = 0; j < layer.length; j++) if (ACTIONABLE.has(layer[j].type)) { regionObj = layer[j]; break; }
      if (!regionObj && layer.length) regionObj = layer[0];
      if (regionObj) regionInfo = { hash: regionHashOfRGBA(rgba, W, H, regionObj.bounds), bounds: regionObj.bounds };
    }

    var payload = {
      siml: "0.3", contentId: contentId, pixelDigest: pixelDigest,
      binding: Object.assign(
        { t0: true, t1: !!t1Mode, t2: wantT2 },
        t1Mode ? { payloadMode: t1Mode, canonicalWidth: W } : {}
      ),
      image: { width: W, height: H },
      permissions: { platformCanDisableSelection: true, platformCanDisableLinks: true, platformCanDisableAll: false },
      textLayer: layer.map(function (o) {
        return Object.assign({}, o, { runs: [{ bounds: o.bounds, text: o.text }], selectable: true, label: null });
      }),
    };

    if (wantT2 && dhash) {
      var body = Object.assign({}, payload);
      if (regionInfo) { body.regionHash = regionInfo.hash; body.regionBounds = regionInfo.bounds; }
      try {
        var res = await fetch(registry, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hash: dhash, payload: body }),
        });
        say(res.ok ? "T2 registered." : "T2 registration failed (HTTP " + res.status + ") - continuing.");
      } catch (e) {
        say("T2 registry unreachable - continuing without it.");
      }
    }

    var dataUrl = format === "jpeg" ? canvas.toDataURL("image/jpeg", 0.92) : canvas.toDataURL("image/png");
    var outBytes = base64ToBytes(dataUrl.slice(dataUrl.indexOf(",") + 1));
    var jumbf = serializeJUMBF(payload);
    var finalBytes = format === "jpeg" ? injectJPEG(outBytes, jumbf) : injectPNG(outBytes, jumbf);

    var ext = format === "jpeg" ? "jpg" : "png";
    var suggested = (host.docName || "artboard") + ".siml." + ext;
    var dlg = window.cep.fs.showSaveDialogEx("Save SIML image", "", [ext], suggested);
    if (dlg.err !== 0 || !dlg.data) { say("Save cancelled."); return; }
    var outPath = dlg.data;
    if (!new RegExp("\\." + ext + "$", "i").test(outPath)) outPath += "." + ext;
    var writeRes = window.cep.fs.writeFile(outPath, bytesToBase64(finalBytes), window.cep.encoding.Base64);
    if (writeRes.err !== 0) { say("Failed: could not write the file (fs err " + writeRes.err + ")."); return; }

    say("Done. Written tiers: T0" + (t1Mode ? " + T1 (" + t1Mode + ")" : "") + (wantT2 ? " + T2" : "") + ".");
    say("Saved " + outPath);
    say("Verify at siml-demo.vercel.app/view (drop the file, run the strip simulator).");
  } catch (err) {
    say("Failed: " + (err && err.message ? err.message : String(err)));
  } finally {
    go.disabled = false;
  }
}

document.getElementById("go").addEventListener("click", run);
