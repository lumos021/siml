// @ts-nocheck - verbatim port of the validated siml-writer engine
// (verified byte-identical by scripts/compare-embedders.js in the SIML
// repo); the starter kit's noUncheckedIndexedAccess would require
// assertions in every DSP hot loop for no safety gain here.
// SIML embedding engine - verbatim port of the validated siml-writer code
// (dual-band QIM watermark, prime-padded stream, RS + CRC fail-loud, JUMBF
// container, 256-bit pHash + 5.3.1 region hash). Host-agnostic: the same
// engine runs in the demo editor, the Figma plugin, and this Canva app.

export const T1_CAPACITY = 16;
const SYNC_TAG = 0xd4b3, Q = 26, QIM_MARGIN = 18, RS_NSYM = 4;
const TEXTURE_EMBED_STDDEV = 8, MIN_TEXTURED_REPS = 8, MIN_POSITION_VOTES = 4, Q_SMOOTH = 13;
const PH_SIZE = 32, PH_LOW = 16;
const SIML_UUID = [0xde, 0x60, 0x62, 0xe1, 0x9e, 0x7b, 0x49, 0x4e, 0x94, 0xb3, 0xdb, 0x6f, 0xcc, 0x25, 0x7f, 0xdc];
export const ACTIONABLE = new Set(["url", "phone", "email", "address"]);

function nextPrime(n: number): number {
  const isP = (k: number) => { for (let d = 2; d * d <= k; d++) if (k % d === 0) return false; return k > 1; };
  while (!isP(n)) n++;
  return n;
}

const RS_EXP = new Uint8Array(512), RS_LOG = new Uint8Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { RS_EXP[i] = x; RS_LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; } for (let i = 255; i < 512; i++) RS_EXP[i] = RS_EXP[i - 255]; })();
const rsMul = (a: number, b: number) => (a && b) ? RS_EXP[RS_LOG[a] + RS_LOG[b]] : 0;

function rsEncode(data: number[], nsym: number): number[] {
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

function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc & 0xffff;
}

const cosT = new Float32Array(64);
for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) cosT[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
const cc = (w: number) => (w === 0 ? 1 / Math.sqrt(2) : 1);

function dct2d(blk: Float32Array): Float32Array {
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

function idct2d(d: Float32Array): Float32Array {
  const out = new Float32Array(64);
  for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {
    let s = 0;
    for (let u = 0; u < 8; u++) { const cu = cc(u), cx = cosT[u * 8 + x]; for (let v = 0; v < 8; v++) s += cu * cc(v) * d[u * 8 + v] * cx * cosT[v * 8 + y]; }
    out[x * 8 + y] = 0.25 * s;
  }
  return out;
}

export function embedWatermark(rgba: Uint8ClampedArray, width: number, height: number, payloadBytes: Uint8Array): { placement: string } {
  const crc = crc16(payloadBytes);
  const rsCoded = rsEncode([...Array.from(payloadBytes), (crc >> 8) & 0xff, crc & 0xff], RS_NSYM);
  const bits: number[] = [];
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

export type LayerObject = {
  id: string; text: string; type: string; intent?: string; primary?: boolean;
  bounds: { x: number; y: number; w: number; h: number };
};

// Spec 4.5.1 payload selection (mirrors siml-writer, incl. actionable fallback).
export function selectT1Payload(layer: LayerObject[], contentId: string): { value: string; mode: string } | null {
  const fits = (s: string) => new TextEncoder().encode(s).length <= T1_CAPACITY;
  const chosen = layer.find((o) => o.primary === true) ||
    layer.find((o) => (o.intent || "actionable") === "actionable" && ACTIONABLE.has(o.type));
  if (!chosen) return null;
  if (fits(chosen.text)) return { value: chosen.text, mode: "direct" };
  if (fits(contentId)) return { value: contentId, mode: "id" };
  const fb = layer.find((o) => o !== chosen && (o.intent || "actionable") === "actionable" && ACTIONABLE.has(o.type) && fits(o.text));
  return fb ? { value: fb.text, mode: "direct" } : null;
}

// 256-bit DCT pHash (mirrors siml-writer/src/fingerprint.js).
const phB = (() => {
  const b = new Float64Array(PH_SIZE * PH_SIZE);
  for (let u = 0; u < PH_SIZE; u++) for (let x = 0; x < PH_SIZE; x++) b[u * PH_SIZE + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * PH_SIZE));
  return b;
})();

function pHashGrey(grey: Float64Array): string {
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
  const h = new Uint8Array(32);
  for (let i = 0; i < PH_LOW * PH_LOW; i++) if (co[i] > med) h[i >> 3] |= 1 << (7 - (i & 7));
  return Array.from(h).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function greyOf(canvas: HTMLCanvasElement, sx: number, sy: number, sw: number, sh: number): Float64Array {
  let cur = document.createElement("canvas");
  cur.width = sw; cur.height = sh;
  cur.getContext("2d")!.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  let cw = sw, ch = sh;
  while (cw > 2 * PH_SIZE && ch > 2 * PH_SIZE) {
    const nw = Math.ceil(cw / 2), nh = Math.ceil(ch / 2);
    const nx = document.createElement("canvas");
    nx.width = nw; nx.height = nh;
    const g = nx.getContext("2d")!;
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
    cur = nx; cw = nw; ch = nh;
  }
  const c1 = document.createElement("canvas");
  c1.width = PH_SIZE; c1.height = PH_SIZE;
  const g = c1.getContext("2d")!;
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  g.drawImage(cur, 0, 0, cw, ch, 0, 0, PH_SIZE, PH_SIZE);
  const px = g.getImageData(0, 0, PH_SIZE, PH_SIZE).data;
  const grey = new Float64Array(PH_SIZE * PH_SIZE);
  for (let i = 0; i < PH_SIZE * PH_SIZE; i++) grey[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  return grey;
}

export function pHashOfCanvas(canvas: HTMLCanvasElement): string {
  return pHashGrey(greyOf(canvas, 0, 0, canvas.width, canvas.height));
}

export function regionHashOf(canvas: HTMLCanvasElement, b: { x: number; y: number; w: number; h: number }): string {
  const W = canvas.width, H = canvas.height, padX = 2, padY = 4;
  let left = Math.round(((b.x - padX) / 100) * W), top = Math.round(((b.y - padY) / 100) * H);
  let cw = Math.round(((b.w + 2 * padX) / 100) * W), ch = Math.round(((b.h + 2 * padY) / 100) * H);
  left = Math.max(0, Math.min(left, W - 1)); top = Math.max(0, Math.min(top, H - 1));
  cw = Math.max(1, Math.min(cw, W - left)); ch = Math.max(1, Math.min(ch, H - top));
  return pHashGrey(greyOf(canvas, left, top, cw, ch));
}

// T0 JUMBF serialize + PNG chunk injection (mirrors the demo editor).
const crcTable = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0 ^ -1;
  for (let i = 0; i < bytes.length; i++) c = (c >>> 8) ^ crcTable[(c ^ bytes[i]) & 0xff];
  return (c ^ -1) >>> 0;
}
function u32(arr: Uint8Array, off: number, val: number) {
  arr[off] = (val >>> 24) & 0xff; arr[off + 1] = (val >>> 16) & 0xff; arr[off + 2] = (val >>> 8) & 0xff; arr[off + 3] = val & 0xff;
}
function concat(arrs: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

export function serializeJUMBF(obj: unknown): Uint8Array {
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

export function injectPNG(buf: Uint8Array, payload: Uint8Array): Uint8Array {
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
