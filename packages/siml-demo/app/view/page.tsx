"use client";

import { useState, useRef, useEffect } from "react";

interface TextObject {
  id: string;
  text: string;
  type: string;
  intent?: "actionable" | "readonly" | "auto";
  bounds: { x: number; y: number; w: number; h: number };
  runs?: Array<{ bounds: { x: number; y: number; w: number; h: number }; text: string }>;
  style?: {
    font?: string;
    size?: number;
    weight?: string;
    color?: string;
  };
  selectable: boolean;
  label: string | null;
}

interface MetaJson {
  siml: string;
  contentId: string;
  pixelDigest?: string; // spec §9.3 staleness digest
  image?: {
    width: number;
    height: number;
  };
  binding?: { t0: boolean; t1: boolean; t2: boolean };
  permissions?: {
    platformCanDisableSelection: boolean;
    platformCanDisableLinks: boolean;
    platformCanDisableAll: boolean;
  };
  textLayer: TextObject[];
}

const SIML_UUID = new Uint8Array([
  0xDE, 0x60, 0x62, 0xE1, 0x9E, 0x7B, 0x49, 0x4E, 0x94, 0xB3, 0xDB, 0x6F, 0xCC, 0x25, 0x7F, 0xDC
]);
function nextPrime(n: number): number {
  const isP = (k: number) => { for (let d = 2; d * d <= k; d++) if (k % d === 0) return false; return k > 1; };
  while (!isP(n)) n++;
  return n;
}

const SYNC_TAG = 0xD4B3;
const CANONICAL_WIDTH = 1024;
const Q = 26;
const RS_NSYM = 4;   // must match writer/rs.js
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

// ─── Inline GF(2˸8) RS decoder (same primitive poly 0x11D as writer/rs.js) ─────────
const RS_EXP_V = new Uint8Array(512);
const RS_LOG_V = new Uint8Array(256);
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) { RS_EXP_V[i] = x; RS_LOG_V[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) RS_EXP_V[i] = RS_EXP_V[i - 255];
})();
const vMul = (a: number, b: number) => (a && b) ? RS_EXP_V[RS_LOG_V[a] + RS_LOG_V[b]] : 0;
const vInv = (a: number) => RS_EXP_V[255 - RS_LOG_V[a]];
const vEvalBE = (p: number[], x: number) => { let y = 0; for (const c of p) y = vMul(y, x) ^ c; return y; };
function vRsDecode(codeword: number[], nsym: number): number[] | null {
  try {
    const msg = [...codeword], n = msg.length;
    const synd = Array.from({ length: nsym }, (_, i) => vEvalBE(msg, RS_EXP_V[i]));
    if (synd.every(s => !s)) return codeword.slice(0, -nsym);
    let sigma = [1], B = [1], L = 0, b = 1;
    for (let i = 0; i < nsym; i++) {
      let d = synd[i];
      for (let j = 1; j < sigma.length; j++) if (i - j >= 0) d ^= vMul(sigma[j], synd[i - j]);
      B = [0, ...B];
      if (!d) continue;
      const c = vMul(d, vInv(b));
      const ns = [...sigma]; while (ns.length < B.length) ns.push(0);
      for (let j = 0; j < B.length; j++) ns[j] ^= vMul(c, B[j]);
      if (2 * L <= i) { L = i + 1 - L; B = sigma; b = d; }
      sigma = ns;
    }
    const ne = sigma.length - 1;
    if (!ne || ne * 2 > nsym) return null;
    const errPos: number[] = [];
    for (let k = 0; k < n; k++) {
      const xi = RS_EXP_V[(255 - k) % 255]; let v = 0, xp = 1;
      for (const c of sigma) { v ^= vMul(c, xp); xp = vMul(xp, xi); }
      if (!v) errPos.push(k);
    }
    if (errPos.length !== ne) return null;
    const omega = new Array(nsym).fill(0);
    for (let k = 0; k < nsym; k++)
      for (let j = 0; j <= k && j < sigma.length; j++) omega[k] ^= vMul(synd[k - j], sigma[j]);
    const sd = Array.from({ length: sigma.length - 1 }, (_, i) => i % 2 === 0 ? sigma[i + 1] : 0);
    const corr = [...msg];
    for (const k of errPos) {
      const Xk = RS_EXP_V[k], XkI = RS_EXP_V[(255 - k) % 255];
      let omV = 0, sdV = 0, xp = 1;
      for (const c of omega) { omV ^= vMul(c, xp); xp = vMul(xp, XkI); }
      xp = 1; for (const c of sd) { sdV ^= vMul(c, xp); xp = vMul(xp, XkI); }
      if (!sdV) return null;
      corr[k] ^= vMul(Xk, vMul(omV, vInv(sdV)));
    }
    if (Array.from({ length: nsym }, (_, i) => vEvalBE(corr, RS_EXP_V[i])).some(s => s)) return null;
    return corr.slice(0, -nsym);
  } catch { return null; }
}
// ────────────────────────────────────────────────────────────────────

// Precompute DCT cosine terms
const cosTable = new Float32Array(8 * 8);
for (let u = 0; u < 8; u++) {
  for (let x = 0; x < 8; x++) {
    cosTable[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
}

function cCoeff(w: number) {
  return w === 0 ? 1 / Math.sqrt(2) : 1;
}

// CRC-16/CCITT-FALSE - MUST match siml-writer/src/watermark.js crc16
function crc16(bytes: Uint8Array): number {
  let crc = 0xFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc & 0xFFFF;
}

function dct2d(block: Float32Array): Float32Array {
  const out = new Float32Array(64);
  for (let u = 0; u < 8; u++) {
    const cu = cCoeff(u);
    for (let v = 0; v < 8; v++) {
      const cv = cCoeff(v);
      let sum = 0;
      for (let x = 0; x < 8; x++) {
        const cosX = cosTable[u * 8 + x];
        for (let y = 0; y < 8; y++) {
          sum += block[x * 8 + y] * cosX * cosTable[v * 8 + y];
        }
      }
      out[u * 8 + v] = 0.25 * cu * cv * sum;
    }
  }
  return out;
}

function rgbToY(rgba: Uint8ClampedArray, width: number, height: number): Float32Array {
  const Y = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    Y[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  }
  return Y;
}

const TEXTURE_DECODE_STDDEV = 3; // guard-band include threshold; MUST match siml-writer
const TEXTURE_EMBED_STDDEV = 8;  // dual-band classifier threshold; MUST match siml-writer
const Q_SMOOTH = 13;             // smooth-band quantizer; MUST match siml-writer

function extractWatermarkClient(rgba: Uint8ClampedArray, width: number, height: number, payloadByteLength = 16): Uint8Array | null {
  try {
    const Y = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++)
      Y[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];

    const blocksX = Math.floor(width / 8);
    const blocksY = Math.floor(height / 8);
    const rsByteLen = payloadByteLength + 2 + RS_NSYM;
    const bitLength = nextPrime(16 + rsByteLen * 8); // prime-padded (MUST match siml-writer)

    // Three attempts, each gated by sync + RS + CRC (fail-loud): textured-only,
    // then dual-band (per-block quantizer by the embedder's classifier), then
    // legacy full coverage. MUST match siml-writer/src/watermark.js.
    const attempt = (strategy: "textured" | "dual" | "full"): Uint8Array | null => {
      const softVotes = new Float64Array(bitLength);
      const block = new Float32Array(64);

      for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
          for (let x = 0; x < 8; x++)
            for (let y = 0; y < 8; y++)
              block[x * 8 + y] = Y[((by * 8 + x) * width) + (bx * 8 + y)];

          let q = Q;
          if (strategy !== "full") {
            let m = 0;
            for (let i = 0; i < 64; i++) m += block[i];
            m /= 64;
            let v = 0;
            for (let i = 0; i < 64; i++) { const d = block[i] - m; v += d * d; }
            const sd = Math.sqrt(v / 64);
            if (strategy === "textured") {
              if (sd < TEXTURE_DECODE_STDDEV) continue;
            } else {
              q = sd >= TEXTURE_EMBED_STDDEV ? Q : Q_SMOOTH;
            }
          }

          const dct = dct2d(block);
          const c = dct[2 * 8 + 1];
          // QIM levels every q, bit in the level's parity (MUST match the writer).
          const nearEven = 2 * Math.round(c / (2 * q)) * q;
          const nearOdd = (2 * Math.round((c - q) / (2 * q)) + 1) * q;
          softVotes[(by * blocksX + bx) % bitLength] += (Math.abs(c - nearOdd) - Math.abs(c - nearEven));
        }
      }

      const bits = Array.from(softVotes, (v: number) => v < 0 ? 1 : 0);
      let sync = 0;
      for (let i = 0; i < 16; i++) sync = (sync << 1) | bits[i];
      if (sync !== SYNC_TAG) return null;

      const rsCoded: number[] = [];
      for (let i = 0; i < rsByteLen; i++) {
        let v = 0; for (let b = 0; b < 8; b++) v = (v << 1) | bits[16 + i * 8 + b];
        rsCoded.push(v);
      }

      const decoded = vRsDecode(rsCoded, RS_NSYM);
      if (!decoded) return null;

      const payload = decoded.slice(0, payloadByteLength);
      const extractedCRC = (decoded[payloadByteLength] << 8) | decoded[payloadByteLength + 1];
      let crc = 0xFFFF;
      for (const byte of payload) {
        crc ^= byte << 8;
        for (let bb = 0; bb < 8; bb++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
      }
      if (extractedCRC !== (crc & 0xFFFF)) return null;

      return new Uint8Array(payload);
    };

    return attempt("textured") || attempt("dual") || attempt("full");
  } catch { return null; }
}

// ─── T1 verify mode (spec v0.4 draft): checksum-guided OCR ─────────────────
// The watermark carries "V1" + CRC32 of the normalized authored field. OCR
// reads the visible glyphs; the checksum is a search oracle over standard OCR
// confusions. A value is surfaced only when a candidate's checksum matches:
// exact text, true glyph positions, offline. No match -> fail loud.
const VERIFY_PAYLOAD_LEN = 6;

const V_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function vCrc32(str: string): number {
  const bytes = new TextEncoder().encode(str);
  let crc = 0xFFFFFFFF;
  for (const b of bytes) crc = (crc >>> 8) ^ V_CRC_TABLE[(crc ^ b) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Candidate normalizations (the reader doesn't know the field type in V1):
// phone-style (+digits, min 8 chars) and generic (collapsed whitespace).
function verifyNormalizations(s: string): string[] {
  const out: string[] = [];
  const phone = s.replace(/[^+\d]/g, "");
  if (phone.replace(/\D/g, "").length >= 8) out.push(phone);
  const generic = s.normalize("NFC").replace(/\s+/g, " ").trim();
  if (generic) out.push(generic);
  return out;
}

const OCR_CONFUSIONS: Record<string, string> = {
  O: "0", o: "0", D: "0", Q: "0",
  l: "1", I: "1", i: "1", "|": "1", "!": "1",
  Z: "2", z: "2", E: "3", A: "4",
  S: "5", s: "5", G: "6", b: "6",
  T: "7", "?": "7", B: "8", g: "9", q: "9",
};
const MAX_ORACLE_CANDIDATES = 4096;

function oracleSearch(windowText: string, expectedCrc: number): string | null {
  const chars = [...windowText];
  const slots: number[] = [];
  chars.forEach((ch, idx) => { if (OCR_CONFUSIONS[ch]) slots.push(idx); });
  const total = Math.min(1 << slots.length, MAX_ORACLE_CANDIDATES);
  for (let mask = 0; mask < total; mask++) {
    const c = [...chars];
    for (let s = 0; s < slots.length; s++) {
      if (mask & (1 << s)) c[slots[s]] = OCR_CONFUSIONS[chars[slots[s]]];
    }
    for (const norm of verifyNormalizations(c.join(""))) {
      if (vCrc32(norm) === expectedCrc) return norm;
    }
  }
  return null;
}

// Load tesseract.js from CDN on demand (only when a V1 checksum was actually
// recovered from the pixels - no OCR cost otherwise). ~2 MB + cached lang data.
function loadTesseract(): Promise<any> {
  const w = window as any;
  if (w.Tesseract) return Promise.resolve(w.Tesseract);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/tesseract.min.js";
    s.onload = () => resolve(w.Tesseract);
    s.onerror = () => reject(new Error("could not load OCR engine"));
    document.head.appendChild(s);
  });
}

// OCR the delivered image and search word windows for the value whose checksum
// matches. Keeps the TIGHTEST matching window so labels ("Call:") and OCR junk
// don't inflate the rendered box - the overlay must hug the value's glyphs.
async function runVerifyOcr(
  imgEl: HTMLImageElement,
  expectedCrc: number
): Promise<{ exact: string; raw: string; bounds: { x: number; y: number; w: number; h: number } } | null> {
  const W = imgEl.naturalWidth, H = imgEl.naturalHeight;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  c.getContext("2d")!.drawImage(imgEl, 0, 0);

  const Tesseract = await loadTesseract();
  const worker = await Tesseract.createWorker("eng");
  let ocr: any;
  try {
    ({ data: ocr } = await worker.recognize(c.toDataURL("image/png"), {}, { blocks: true, text: true }));
  } finally {
    await worker.terminate();
  }

  const lines: any[] = (ocr.blocks || []).flatMap((b: any) =>
    (b.paragraphs || []).flatMap((p: any) => p.lines || []));

  let best: { exact: string; raw: string; start: number; end: number; line: any } | null = null;
  for (const line of lines) {
    const raw = (line.text || "").trim();
    if (!raw) continue;
    const words = raw.split(/\s+/);
    for (let start = 0; start < words.length; start++) {
      for (let end = start + 1; end <= words.length; end++) {
        const windowText = words.slice(start, end).join(" ");
        const exact = oracleSearch(windowText, expectedCrc);
        if (exact && (!best || (end - start) < (best.end - best.start))) {
          best = { exact, raw: windowText, start, end, line };
        }
      }
    }
  }
  if (!best) return null;

  const boxes = (best.line.words || []).slice(best.start, best.end).map((w: any) => w.bbox);
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b: any) => b.x0)), y0 = Math.min(...boxes.map((b: any) => b.y0));
  const x1 = Math.max(...boxes.map((b: any) => b.x1)), y1 = Math.max(...boxes.map((b: any) => b.y1));
  return {
    exact: best.exact,
    raw: best.raw,
    bounds: {
      x: +(100 * x0 / W).toFixed(2),
      y: +(100 * y0 / H).toFixed(2),
      w: +(100 * (x1 - x0) / W).toFixed(2),
      h: +(100 * (y1 - y0) / H).toFixed(2),
    },
  };
}

// T2 match threshold on the 256-bit hash (spec §5.3 ratified reference: ≤ 24).
const T2_MATCH_THRESHOLD = 24;

function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return Infinity;
  let dist = 0;
  for (let i = 0; i < a.length; i += 2) {
    let xor = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    while (xor > 0) { if (xor & 1) dist++; xor >>>= 1; }
  }
  return dist;
}

const REGION_MATCH_THRESHOLD = 40; // spec §5.3.1 - MUST match reader/writer

// §5.3.1 step 1 - all entries within threshold, nearest first.
function fingerprintCandidates(dhash: string, registry: Record<string, any>) {
  const out: { hash: string; dist: number; entry: any }[] = [];
  for (const key of Object.keys(registry)) {
    const dist = hammingHex(dhash, key);
    if (dist <= T2_MATCH_THRESHOLD) out.push({ hash: key, dist, entry: registry[key] });
  }
  return out.sort((a, b) => a.dist - b.dist);
}

// §5.3.1 steps 2+3 - region-hash pixel veto. Among candidates, pick the one whose
// stored regionHash matches the query's region pixels; accept only within
// REGION_MATCH_THRESHOLD, and reject on ambiguity. Returns entry or null (reject).
function verifyT2Client(
  candidates: { hash: string; dist: number; entry: any }[],
  imgEl: HTMLImageElement
) {
  const withRegion = candidates.filter(c => c.entry?.regionHash && c.entry?.regionBounds);
  if (withRegion.length) {
    const scored = withRegion
      .map(c => ({ c, rd: hammingHex(c.entry.regionHash, regionHashClient(imgEl, c.entry.regionBounds) || "") }))
      .filter(s => Number.isFinite(s.rd))
      .sort((a, b) => a.rd - b.rd);
    if (!scored.length) return null;
    const best = scored[0];
    if (best.rd > REGION_MATCH_THRESHOLD) return null;                 // no region consistent → reject
    if (scored[1] && scored[1].rd <= best.rd + 4) return null;         // ambiguous → reject
    return { entry: best.c.entry, dist: best.c.dist, regionDist: best.rd };
  }
  // No region hashes: only trust a single, tight, unambiguous whole-image match.
  if (candidates.length === 1 && candidates[0].dist <= 6) {
    return { entry: candidates[0].entry, dist: candidates[0].dist, regionDist: null };
  }
  return null;
}

// Region pHash of the query image (spec §5.3.1) - MUST match reader/writer.
function regionHashClient(img: HTMLImageElement, b: { x: number; y: number; w: number; h: number }): string | null {
  try {
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
    if (!W || !H) return null;
    const padX = 2, padY = 4;
    let left = Math.round(((b.x - padX) / 100) * W);
    let top = Math.round(((b.y - padY) / 100) * H);
    let cw = Math.round(((b.w + 2 * padX) / 100) * W);
    let ch = Math.round(((b.h + 2 * padY) / 100) * H);
    left = Math.max(0, Math.min(left, W - 1)); top = Math.max(0, Math.min(top, H - 1));
    cw = Math.max(1, Math.min(cw, W - left)); ch = Math.max(1, Math.min(ch, H - top));
    const c = document.createElement("canvas"); c.width = PH_SIZE; c.height = PH_SIZE;
    const cx = c.getContext("2d")!; cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = "high";
    cx.drawImage(img, left, top, cw, ch, 0, 0, PH_SIZE, PH_SIZE);
    const data = cx.getImageData(0, 0, PH_SIZE, PH_SIZE).data;
    const grey = new Float64Array(PH_SIZE * PH_SIZE);
    for (let i = 0; i < PH_SIZE * PH_SIZE; i++)
      grey[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    return pHashGrey32(grey);
  } catch { return null; }
}

// 256-bit DCT pHash (spec §5.2) - MUST match siml-writer/src/fingerprint.js.
const PH_SIZE = 32;
const STALE_THRESHOLD = 10; // spec §9.3 - MUST match siml-writer/reader
const PH_LOW = 16;
const phDctBasis = (() => {
  const b = new Float64Array(PH_SIZE * PH_SIZE);
  for (let u = 0; u < PH_SIZE; u++)
    for (let x = 0; x < PH_SIZE; x++)
      b[u * PH_SIZE + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * PH_SIZE));
  return b;
})();

function calculatePHashClient(rgba: Uint8ClampedArray, width: number, height: number): string {
  let offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  const oCtx = offscreen.getContext('2d')!;
  oCtx.putImageData(new ImageData(rgba as any, width, height), 0, 0);

  // Halve recursively to prevent sub-sampling aliasing
  let srcWidth = width
  let srcHeight = height
  while (srcWidth > 2 * PH_SIZE && srcHeight > 2 * PH_SIZE) {
    const nextWidth = Math.ceil(srcWidth / 2)
    const nextHeight = Math.ceil(srcHeight / 2)
    const nextCanvas = document.createElement('canvas')
    nextCanvas.width = nextWidth
    nextCanvas.height = nextHeight
    const nextCtx = nextCanvas.getContext('2d')
    if (!nextCtx) break
    nextCtx.imageSmoothingEnabled = true
    nextCtx.imageSmoothingQuality = 'high'
    nextCtx.drawImage(offscreen, 0, 0, srcWidth, srcHeight, 0, 0, nextWidth, nextHeight)
    offscreen = nextCanvas
    srcWidth = nextWidth
    srcHeight = nextHeight
  }

  const small = document.createElement('canvas');
  small.width = PH_SIZE;
  small.height = PH_SIZE;
  const sCtx = small.getContext('2d')!;
  sCtx.imageSmoothingEnabled = true;
  sCtx.imageSmoothingQuality = 'high';
  sCtx.drawImage(offscreen, 0, 0, srcWidth, srcHeight, 0, 0, PH_SIZE, PH_SIZE);
  const data = sCtx.getImageData(0, 0, PH_SIZE, PH_SIZE).data;

  const grey = new Float64Array(PH_SIZE * PH_SIZE);
  for (let i = 0; i < PH_SIZE * PH_SIZE; i++)
    grey[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];

  return pHashGrey32(grey);
}

// 256-bit pHash of a 32×32 greyscale - the shared DCT-hash core (§5.2 / §5.3.1).
function pHashGrey32(grey: Float64Array): string {
  const rows = new Float64Array(PH_SIZE * PH_SIZE);
  for (let y = 0; y < PH_SIZE; y++)
    for (let u = 0; u < PH_SIZE; u++) {
      let sum = 0;
      for (let x = 0; x < PH_SIZE; x++) sum += grey[y * PH_SIZE + x] * phDctBasis[u * PH_SIZE + x];
      rows[y * PH_SIZE + u] = sum;
    }
  const dct = new Float64Array(PH_SIZE * PH_SIZE);
  for (let u = 0; u < PH_SIZE; u++)
    for (let v = 0; v < PH_SIZE; v++) {
      let sum = 0;
      for (let y = 0; y < PH_SIZE; y++) sum += rows[y * PH_SIZE + v] * phDctBasis[u * PH_SIZE + y];
      dct[u * PH_SIZE + v] = sum;
    }
  const coeffs = new Float64Array(PH_LOW * PH_LOW);
  let k = 0;
  for (let u = 0; u < PH_LOW; u++)
    for (let v = 0; v < PH_LOW; v++) coeffs[k++] = dct[u * PH_SIZE + v];
  const sortedNoDC = Array.from(coeffs).slice(1).sort((a, b) => a - b);
  const median = sortedNoDC[Math.floor(sortedNoDC.length / 2)];
  const hash = new Uint8Array(32);
  for (let i = 0; i < PH_LOW * PH_LOW; i++)
    if (coeffs[i] > median) hash[i >> 3] |= (1 << (7 - (i & 7)));
  return Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── T0 JUMBF Parsing ───
function isPNG(bytes: Uint8Array) {
  return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50;
}
function isJPEG(bytes: Uint8Array) {
  return bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xD8;
}
function isWebP(bytes: Uint8Array) {
  return bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49;
}

function parseJUMBF(arrayBuffer: ArrayBuffer, byteOffset: number, length: number): any {
  try {
    const bytes = new Uint8Array(arrayBuffer, byteOffset, length);
    const v = new DataView(arrayBuffer, byteOffset, length);
    const superLength = v.getUint32(0, false);
    let pos = 8;
    let payload = null;

    while (pos < superLength && pos < bytes.length) {
      if (pos + 8 > bytes.length) break;
      const boxLength = v.getUint32(pos, false);
      const boxType = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);

      if (boxType === 'jumbd') {
        const uuid = bytes.subarray(pos + 8, pos + 24);
        const match = SIML_UUID.every((b, i) => uuid[i] === b);
        if (!match) return null;
      } else if (boxType === 'json') {
        if (boxLength - 8 > MAX_PAYLOAD_BYTES) return null; // oversized → skip
        const dataBytes = bytes.subarray(pos + 8, pos + boxLength);
        const jsonStr = new TextDecoder('utf-8').decode(dataBytes);
        payload = JSON.parse(jsonStr);
      }
      pos += boxLength;
    }
    return payload;
  } catch (e) {
    return null;
  }
}

function extractMetadata(arrayBuffer: ArrayBuffer): MetaJson | null {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  if (isPNG(bytes)) {
    let pos = 8;
    while (pos < bytes.length) {
      if (pos + 8 > bytes.length) break;
      const length = view.getUint32(pos);
      const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      if (type === 'siMl') {
        return parseJUMBF(arrayBuffer, pos + 8, length);
      }
      pos += 12 + length;
    }
  } else if (isJPEG(bytes)) {
    let pos = 2;
    while (pos < bytes.length - 1) {
      if (bytes[pos] !== 0xFF) break;
      const marker = (bytes[pos] << 8) | bytes[pos + 1];
      if (marker === 0xFFDA) break;
      const segLen = view.getUint16(pos + 2, false);
      if (marker === 0xFFEB) { // APP11
        if (bytes[pos + 4] === 0x4A && bytes[pos + 5] === 0x50 && bytes[pos + 6] === 0x30 && bytes[pos + 7] === 0x32) {
          return parseJUMBF(arrayBuffer, pos + 12, segLen - 10);
        }
      }
      pos += 2 + segLen;
    }
  } else if (isWebP(bytes)) {
    let pos = 12;
    while (pos < bytes.length - 7) {
      const type = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
      const len = view.getUint32(pos + 4, true);
      if (type === 'siML') {
        return parseJUMBF(arrayBuffer, pos + 8, len);
      }
      pos += 8 + len + (len % 2);
    }
  }
  return null;
}

export default function ViewPage() {
  const [meta, setMeta] = useState<MetaJson | null>(null);
  const [stale, setStale] = useState(false); // spec §9.3: layer ≠ delivered pixels
  const [imageURL, setImageURL] = useState<string | null>(null);
  const [activeTier, setActiveTier] = useState<string | null>(null);
  const [resolutionLogs, setResolutionLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [showHighlight, setShowHighlight] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  // Keep original buffer to allow simulating metadata stripping
  const originalBufferRef = useRef<ArrayBuffer | null>(null);
  const fileTypeRef = useRef<string>("image/png");

  const [scale, setScale] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        setScale(width / 1024);

        // Box-fit BOTH axes so the transparent selection text tracks the baked
        // glyphs regardless of which tool exported the file (demo editor,
        // Canva, Figma): glyph height comes from the recorded bounds box (a
        // tool's font-size units are not trustworthy across hosts), and width
        // is fitted with scaleX.
        const spans = entry.target.querySelectorAll(".siml-text-node");
        spans.forEach((span: any) => {
          const wPct = parseFloat(span.dataset.simlW || "0");
          if (!wPct) return;
          const targetWidthPx = (wPct / 100) * width;

          const boxHeightPx = span.getBoundingClientRect().height;
          if (boxHeightPx > 0) {
            // ~78% of box height approximates cap-height text filling a frame
            span.style.fontSize = `${(boxHeightPx * 0.78).toFixed(2)}px`;
          }

          const inner = span.querySelector(".siml-text-inner");
          if (inner) {
            inner.style.transform = "none";
            const naturalWidthPx = inner.getBoundingClientRect().width;
            if (naturalWidthPx > 0) {
              const scaleX = targetWidthPx / naturalWidthPx;
              inner.style.transform = `scaleX(${scaleX.toFixed(4)})`;
            }
          }
        });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [imageURL, meta]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  async function resolvePipeline(buffer: ArrayBuffer, imgElForFallback?: HTMLImageElement) {
    const logs: string[] = [];
    logs.push("🔍 Resolution pipeline triggered...");
    // Log what actually arrived: dimensions tell us what a platform's transcode
    // did to the image (resize kills T1 below ~900px; see spec §4.6).
    if (imgElForFallback) {
      logs.push(`delivered image: ${imgElForFallback.naturalWidth}x${imgElForFallback.naturalHeight}, ${(buffer.byteLength / 1024).toFixed(0)} KB`);
    }

    // TIER 0: JUMBF Container Check
    logs.push("T0: Checking JUMBF metadata boxes...");
    const t0Meta = extractMetadata(buffer);
    if (t0Meta) {
      logs.push("✅ T0 Match Found! Extracted JUMBF payload.");
      // Staleness (spec §9.3): recompute pixelDigest from the delivered pixels.
      let isStaleLayer = false;
      if (t0Meta.pixelDigest && imgElForFallback) {
        const c = document.createElement("canvas");
        c.width = imgElForFallback.naturalWidth;
        c.height = imgElForFallback.naturalHeight;
        const cx = c.getContext("2d")!;
        cx.drawImage(imgElForFallback, 0, 0);
        const live = calculatePHashClient(cx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
        const d = hammingHex(t0Meta.pixelDigest, live);
        isStaleLayer = d > STALE_THRESHOLD;
        logs.push(isStaleLayer
          ? `⚠️ STALE: pixelDigest mismatch (dist ${d} > ${STALE_THRESHOLD}) - pixels were edited; suppressing actions.`
          : `🔒 Fresh: pixelDigest matches delivered pixels (dist ${d}).`);
      }
      setStale(isStaleLayer);
      setMeta(t0Meta);
      setActiveTier(isStaleLayer ? "T0 (JUMBF) - STALE" : "T0 (JUMBF Container)");
      setResolutionLogs(logs);
      return;
    }
    logs.push("❌ T0 JUMBF container lookup failed (stripped or empty).");

    // TIER 1: Pixel Watermark Check
    logs.push("T1: Attempting Y-Luminance DCT Watermark extraction...");
    let t1Text: string | null = null;
    if (imgElForFallback) {
      const canvas = document.createElement("canvas");
      canvas.width = CANONICAL_WIDTH;
      const aspect = imgElForFallback.naturalHeight / imgElForFallback.naturalWidth;
      canvas.height = Math.round((CANONICAL_WIDTH * aspect) / 8) * 8;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(imgElForFallback, 0, 0, canvas.width, canvas.height);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      const watermarkBytes = extractWatermarkClient(imgData.data, canvas.width, canvas.height, 16);
      if (watermarkBytes) {
        t1Text = new TextDecoder("utf-8").decode(watermarkBytes).replace(/\0/g, "");
        logs.push(`✅ T1 Match Found! Extracted direct payload from pixels: "${t1Text}"`);
      }

      // T1 verify mode (spec v0.4 draft): if no direct payload, try the short
      // checksum stream, then let OCR + the oracle recover exact text + position.
      if (!t1Text) {
        const vBytes = extractWatermarkClient(imgData.data, canvas.width, canvas.height, VERIFY_PAYLOAD_LEN);
        if (vBytes && vBytes[0] === 0x56 && vBytes[1] === 0x31) { // "V1"
          const expectedCrc = ((vBytes[2] << 24) | (vBytes[3] << 16) | (vBytes[4] << 8) | vBytes[5]) >>> 0;
          logs.push(`T1v: verify checksum recovered from pixels (${expectedCrc.toString(16)}). Running OCR + oracle search...`);
          try {
            const verified = await runVerifyOcr(imgElForFallback, expectedCrc);
            if (verified) {
              logs.push(`✅ T1v VERIFIED: OCR read "${verified.raw}" -> exact value "${verified.exact}" (checksum-proven).`);
              logs.push(`   position from OCR boxes: ${JSON.stringify(verified.bounds)}`);
              const type = /^\+?\d{8,}$/.test(verified.exact) ? "phone"
                : /^https?:/i.test(verified.exact) ? "url" : "text";
              setStale(false);
              setMeta({
                siml: "0.3",
                contentId: "t1v-verified",
                textLayer: [{
                  id: "t1v",
                  text: verified.exact,
                  type,
                  bounds: verified.bounds,
                  runs: [{ bounds: verified.bounds, text: verified.exact }],
                  selectable: true,
                  label: "Verified visible text",
                }],
              });
              setActiveTier("T1v Verified Text (checksum + OCR)");
              setResolutionLogs(logs);
              return;
            }
            logs.push("🛑 T1v: the checksum itself SURVIVED the channel, but OCR could not verify the visible text on this content (busy/photographic images defeat OCR) - failing loud, not guessing. For offline recovery on content like this, export with Verify mode OFF (direct mode).");
          } catch (e) {
            logs.push(`T1v: OCR engine unavailable (${(e as Error).message}) - skipping verify mode.`);
          }
        }
      }
    }
    if (!t1Text) {
      logs.push("❌ T1 Watermark extraction failed.");
    }

    // TIER 2: Fingerprint Registry Check - try HTTP first, then localStorage
    logs.push("T2: Computing appearance perceptual hash...");
    if (imgElForFallback) {
      const canvas = document.createElement("canvas");
      canvas.width = imgElForFallback.naturalWidth;
      canvas.height = imgElForFallback.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(imgElForFallback, 0, 0);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      const dhash = calculatePHashClient(imgData.data, canvas.width, canvas.height);
      logs.push(`computed pHash: ${dhash}`);

      // Try HTTP registry first (cross-session)
      let match: { entry: any; dist: number } | null = null;
      try {
        const res = await fetch(`/api/registry?hash=${dhash}`);
        if (res.ok) {
          const json = await res.json();
          // §5.3.1: prefer the candidate SET; a server hit is a hypothesis, verify
          // against the query's pixels via the region veto before surfacing.
          const cands = (json.candidates && json.candidates.length)
            ? json.candidates.map((c: any) => ({ hash: c.key, dist: c.dist, entry: c.entry }))
            : (json.match ? [{ hash: dhash, dist: json.dist, entry: json.match }] : []);
          if (cands.length) {
            const hasRegion = cands.some((c: any) => c.entry?.regionHash && c.entry?.regionBounds);
            if (hasRegion) {
              const v = verifyT2Client(cands, imgElForFallback);
              if (v) { match = { entry: v.entry, dist: v.dist }; logs.push(`T2 HTTP: ${cands.length} candidate(s), region-verified (region dist ${v.regionDist ?? "n/a"})`); }
              else logs.push(`🛑 T2 HTTP: ${cands.length} candidate(s) but region veto REJECTED all (§5.3.1) - not surfacing.`);
            } else if (cands.length === 1 && cands[0].dist <= 6) {
              match = { entry: cands[0].entry, dist: cands[0].dist };
              logs.push(`T2 HTTP hit (tight single match, no region hash; dist ${cands[0].dist})`);
            } else {
              logs.push(`🛑 T2 HTTP: ${cands.length} candidate(s), no region hash to disambiguate - not surfacing a guess.`);
            }
          }
        }
      } catch { /* offline */ }

      // Fallback: localStorage mock - with §5.3.1 verification (candidate set +
      // region-hash pixel veto), so a near-duplicate template can't return a
      // confident wrong number.
      if (!match) {
        let registry: Record<string, any> = {};
        try { registry = JSON.parse(localStorage.getItem("siml-registry") || "{}"); } catch { }
        const candidates = fingerprintCandidates(dhash, registry);
        if (candidates.length) {
          logs.push(`T2 candidates within threshold: ${candidates.length} (dists ${candidates.map(c => c.dist).join(", ")})`);
          const verified = verifyT2Client(candidates, imgElForFallback);
          if (verified) {
            match = { entry: verified.entry, dist: verified.dist };
            logs.push(`🔒 §5.3.1 verified via region hash (region dist ${verified.regionDist ?? "n/a"})`);
          } else {
            logs.push(`🛑 §5.3.1 verification REJECTED all candidates - near-dup ambiguity or region mismatch; not surfacing a guess.`);
          }
        }
      }

      if (match) {
        logs.push(`✅ T2 Registry Match (verified). Retrieved full text layer.`);
        // Staleness (spec §9.3) applies to T2 recoveries too: `dhash` is the same
        // perceptual digest machinery as pixelDigest, computed above from the
        // delivered pixels. Legit degradation (re-encode/downscale/screenshot)
        // measures <= 6 bits; a content edit measures 44-58, so a registry entry
        // whose pixels were since edited shows as unverified with actions off.
        let t2Stale = false;
        if (match.entry?.pixelDigest) {
          const d = hammingHex(match.entry.pixelDigest, dhash);
          t2Stale = d > STALE_THRESHOLD;
          logs.push(t2Stale
            ? `⚠️ STALE: registry layer's pixelDigest mismatches delivered pixels (dist ${d} > ${STALE_THRESHOLD}) - suppressing actions.`
            : `🔒 Fresh: pixelDigest matches delivered pixels (dist ${d}).`);
        }
        setStale(t2Stale);
        setMeta(match.entry);
        setActiveTier(`T2 Registry${t2Stale ? " - STALE" : ""} ${t1Text ? "(with T1 Offline Fallback)" : ""}`);
        setResolutionLogs(logs);
        return;
      }
    }
    logs.push("❌ T2 Fingerprint registry lookup failed.");

    // Fallback to T1 Direct payload if T2 failed. T1 direct mode carries the
    // VALUE only (no geometry), so we must not draw a positioned overlay; the
    // recovered field is surfaced in the side panel instead (bounds are a
    // placeholder and the render layer skips T1-only recoveries).
    if (t1Text) {
      logs.push("ℹ️ T2 failed or offline. Falling back to offline T1 direct payload.");
      logs.push("ℹ️ T1 carries the value itself, not its position: no overlay is drawn; use the panel to copy or act.");
      const mockMeta: MetaJson = {
        siml: "0.3",
        contentId: "t1-resolved",
        textLayer: [{
          id: "t1",
          text: t1Text,
          type: t1Text.includes("http") ? "url" : "phone",
          bounds: { x: 0, y: 0, w: 0, h: 0 },
          selectable: true,
          label: "Watermark Recovery"
        }]
      };
      setMeta(mockMeta);
      setActiveTier("T1 (Pixel Watermark)");
      setResolutionLogs(logs);
      return;
    }

    // Fallback
    logs.push("⚠️ All SIML Tiers failed. Fallback to basic OCR / Raster only.");
    setError("Could not extract any SIML layers.");
    setResolutionLogs(logs);
  }

  async function handleFile(file: File) {
    setError(null);
    setMeta(null);
    setStale(false);
    setImageURL(null);
    setActiveTier(null);
    setResolutionLogs([]);

    try {
      const buffer = await file.arrayBuffer();
      originalBufferRef.current = buffer;
      fileTypeRef.current = file.type;

      const blob = new Blob([buffer], { type: file.type });
      const url = URL.createObjectURL(blob);
      setImageURL(url);

      // We resolve pipeline once the Image Element is loaded in DOM to assist T1/T2 Canvas calculations
      const img = new Image();
      img.onload = () => {
        resolvePipeline(buffer, img);
      };
      img.src = url;
    } catch (e) {
      setError(`Failed to read file: ${(e as Error).message}`);
    }
  }

  // Load a bundled real SIML sample (genuine T0/T1/T2 embedded) so a visitor can
  // see the pipeline without bringing their own file.
  async function loadSample(url: string, type: string) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`could not fetch sample (${resp.status})`);
      const buffer = await resp.arrayBuffer();
      const name = url.split("/").pop() || "sample";
      await handleFile(new File([buffer], name, { type }));
    } catch (e) {
      setError(`Failed to load sample: ${(e as Error).message}`);
    }
  }

  // Simulator: Strip all JUMBF metadata and compress to flat low-quality JPEG
  function simulateStripAndRecompress() {
    if (!imageRef.current) return;
    setError(null);
    setMeta(null);
    setStale(false);
    setActiveTier(null);

    const canvas = document.createElement("canvas");
    const img = imageRef.current;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);

    // Save using format-appropriate re-compression (WebP to WebP at 0.92, JPEG to JPEG at 0.90)
    const fileType = fileTypeRef.current || "image/png";
    const mime = fileType === "image/webp" ? "image/webp" : "image/jpeg";
    const quality = fileType === "image/webp" ? 0.92 : 0.90;
    const strippedDataURL = canvas.toDataURL(mime, quality);
    setImageURL(strippedDataURL);

    // Load stripped image back and trigger pipeline
    const nextImg = new Image();
    nextImg.onload = async () => {
      // Create empty arraybuffer to emulate standard stripped image
      const response = await fetch(strippedDataURL);
      const buffer = await response.arrayBuffer();
      resolvePipeline(buffer, nextImg);
    };
    nextImg.src = strippedDataURL;
    showToast(`Simulated strip: JUMBF metadata removed, re-compressed ${mime.split("/")[1].toUpperCase()} pixels!`);
  }

  // Anti-cloaking (spec §9.2): actionable types may have no visible twin, so
  // surface the literal target and require confirmation before acting on it.
  // We never auto-dial/open/navigate - every action is gated by reveal-then-act.
  const ACTIONABLE_TYPES = new Set(["url", "phone", "email", "address"]);

  // §9.2.3 safe scheme allow-list - reject javascript:/data:/file: etc.
  const SAFE_SCHEMES = ["https:", "http:", "tel:", "mailto:", "geo:"]; // http: upgraded to https in actionFor
  function isSafeScheme(url: string): boolean {
    const m = /^([a-z][a-z0-9+.-]*:)/i.exec(url.trim());
    if (!m) return true; // no scheme → we prepend https:// ourselves
    return SAFE_SCHEMES.includes(m[1].toLowerCase());
  }

  // Map a typed value to the OS URL scheme that routes it (dialer/mail/maps/web).
  // Native scheme semantics do the platform routing for us - we just hand off.
  // Returns null when the value can't be safely actioned (§9.2.3).
  function actionFor(type: string, text: string): { scheme: string; verb: string } | null {
    switch (type) {
      case "phone":
        return { scheme: `tel:${text.replace(/[^+\d]/g, "")}`, verb: "Call" };
      case "email":
        return { scheme: `mailto:${text.trim()}`, verb: "Email" };
      case "url": {
        if (!isSafeScheme(text)) return null;
        const href = /^https?:\/\//i.test(text) ? text : `https://${text}`;
        return { scheme: href.replace(/^http:\/\//i, "https://"), verb: "Open" };
      }
      case "address":
        return { scheme: `https://maps.google.com/?q=${encodeURIComponent(text)}`, verb: "Directions" };
      default:
        return null;
    }
  }

  // §8.1 authority order: permissions (MUST) → platform → intent (SHOULD).
  // `intent` defaults to 'actionable'. The demo platform doesn't disable links.
  // A STALE layer (spec §9.3) suppresses ALL actions - the text no longer matches
  // the pixels, so it is not authoritative.
  function isActionEnabled(obj: { type: string; text: string; intent?: string }): boolean {
    if (stale) return false;
    if (!ACTIONABLE_TYPES.has(obj.type)) return false;
    if ((obj.intent || "actionable") === "readonly") return false;
    return actionFor(obj.type, obj.text) !== null;
  }

  async function copyText(text: string, type?: string) {
    if (type && ACTIONABLE_TYPES.has(type)) {
      const ok = window.confirm(
        `This image wants to share a ${type}:\n\n${text}\n\nCopy it to your clipboard?`
      );
      if (!ok) return;
    }
    await navigator.clipboard.writeText(text);
    showToast(`Copied: "${text}"`);
  }

  // Reveal-then-act: show the LITERAL target + destination, and only on explicit
  // confirm do we navigate. Never silently fire tel:/mailto:/http on tap.
  function actOn(type: string, text: string) {
    const action = actionFor(type, text);
    if (!action) return;
    const ok = window.confirm(
      `${action.verb} this ${type}?\n\nShown: ${text}\nWill open: ${action.scheme}\n\n` +
      `⚠ The image's hidden text may differ from what you see. Proceed only if this looks right.`
    );
    if (!ok) return;
    if (action.scheme.startsWith("http")) {
      window.open(action.scheme, "_blank", "noopener,noreferrer");
    } else {
      window.location.href = action.scheme;
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>SIML Resilience Viewer</h1>
        <p>Drop an image. View selectable text. Test pipeline survival after stripping all metadata.</p>
      </div>

      {!imageURL && (
        <div
          className={`dropzone ${isDragging ? "active" : ""}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            const file = e.dataTransfer.files[0];
            if (file) handleFile(file);
          }}
        >
          <div className="dropzone-icon">📥</div>
          <h3>Upload visual SIML image</h3>
          <p>PNG, JPG, or WebP with v0.3 tiers</p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />

          {/* Real bundled SIML samples - genuine T0/T1/T2, no file needed */}
          <div
            style={{ marginTop: "1.5rem", paddingTop: "1.25rem", borderTop: "1px solid var(--border)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <p style={{ fontSize: "0.8125rem", color: "var(--text-secondary)", marginBottom: "0.75rem" }}>
              …or try a real SIML sample (T0 + T1 + T2 embedded):
            </p>
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center", flexWrap: "wrap" }}>
              <button className="btn btn-secondary btn-sm" onClick={() => loadSample("/test.siml.png", "image/png")}>🖼 PNG sample</button>
              <button className="btn btn-secondary btn-sm" onClick={() => loadSample("/test.siml.jpg", "image/jpeg")}>📷 JPEG sample</button>
              <button className="btn btn-secondary btn-sm" onClick={() => loadSample("/test.siml.webp", "image/webp")}>🌐 WebP sample</button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="toast toast-error" style={{ marginTop: "1rem" }}>
          {error}
        </div>
      )}

      {imageURL && (
        <div className="viewer-container viewer-grid-container">
          {/* Left panel: Image Render Overlay */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <h2 style={{ fontSize: "1.125rem", fontWeight: 600 }}>Interactive Image Layer</h2>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  className={`btn btn-sm ${showHighlight ? "btn-primary" : "btn-secondary"}`}
                  onClick={() => setShowHighlight(!showHighlight)}
                >
                  {showHighlight ? "⬤ Selection Highlights On" : "○ Highlights Off"}
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    setMeta(null);
                    setStale(false);
                    setImageURL(null);
                    setActiveTier(null);
                    setResolutionLogs([]);
                  }}
                >
                  ✕ Close
                </button>
              </div>
            </div>

            {activeTier?.startsWith("T1v") && (
              <div style={{
                marginBottom: "0.75rem", padding: "0.75rem 1rem", borderRadius: "8px",
                background: "rgba(45,212,168,0.10)", border: "1px solid rgba(45,212,168,0.35)",
                color: "var(--text-primary)", fontSize: "0.85rem",
              }}>
                ✅ Verified visible text: a checksum embedded in the pixels proved the OCR reading
                exact (byte for byte). Overlay position comes from the actual glyphs.
              </div>
            )}

            {activeTier === "T1 (Pixel Watermark)" && (
              <div style={{
                marginBottom: "0.75rem", padding: "0.75rem 1rem", borderRadius: "8px",
                background: "rgba(45,212,168,0.10)", border: "1px solid rgba(45,212,168,0.35)",
                color: "var(--text-primary)", fontSize: "0.85rem",
              }}>
                🔓 Recovered offline from the pixel watermark. The watermark carries the value
                itself but not its position, so nothing is highlighted on the image; copy or act
                on the recovered field in the panel on the right.
              </div>
            )}

            {stale && (
              <div style={{
                marginBottom: "0.75rem", padding: "0.75rem 1rem", borderRadius: "8px",
                background: "rgba(248,113,113,0.12)", border: "1px solid rgba(248,113,113,0.4)",
                color: "#f87171", fontSize: "0.85rem", fontWeight: 500,
              }}>
                ⚠️ STALE LAYER - the embedded text no longer matches the image pixels (it was edited after authoring).
                Actions are disabled and the text is shown <strong>unverified</strong>; trust the visible image, not the layer.
              </div>
            )}

            <div ref={containerRef} className="siml-render-area" style={{ position: "relative" }}>
              <img
                ref={imageRef}
                src={imageURL}
                alt="SIML source renderer"
                style={{ width: "100%", height: "auto", borderRadius: "12px", border: "1px solid var(--border)" }}
                draggable={false}
              />

              {/* Positioned Selectable SIML Text overlays. Skipped for T1-only
                  recoveries: the watermark carries the value without geometry,
                  and a made-up box would mislead (the field lives in the side
                  panel instead). */}
              {meta && activeTier !== "T1 (Pixel Watermark)" && meta.textLayer.map((obj) => (
                <span
                  key={obj.id}
                  className="siml-text-node"
                  data-siml-w={obj.bounds.w}
                  style={{
                    position: "absolute",
                    left: `${obj.bounds.x}%`,
                    top: `${obj.bounds.y}%`,
                    width: `${obj.bounds.w}%`,
                    height: `${obj.bounds.h}%`,
                    color: "transparent",
                    // A single, subtle fill marks the selectable region. (No
                    // separate border: box + border + the native ::selection
                    // highlight together read as "multiple boxes" on a short
                    // field - the fill alone is enough affordance.)
                    background: showHighlight ? "rgba(108, 99, 255, 0.18)" : "transparent",
                    borderRadius: "3px",
                    userSelect: "text",
                    cursor: isActionEnabled(obj) ? "pointer" : "text",
                    display: "flex",
                    alignItems: "flex-start",
                    padding: 0,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    fontSize: `${(obj.style?.size || 16) * 1.5 * scale}px`,
                    fontFamily: obj.style?.font ? `${obj.style.font}, sans-serif` : "inherit",
                    fontWeight: obj.style?.weight === "medium" ? "500" : (obj.style?.weight || "normal"),
                    lineHeight: 1.0
                  }}
                  aria-label={obj.text}
                  role={isActionEnabled(obj) ? "button" : undefined}
                  onClick={() => {
                    // Don't hijack a text selection; only act on a plain click.
                    if (window.getSelection()?.toString()) return;
                    if (isActionEnabled(obj)) actOn(obj.type, obj.text);
                  }}
                >
                  <span
                    className="siml-text-inner"
                    style={{
                      display: "inline-block",
                      whiteSpace: "nowrap",
                      width: "auto",
                      transformOrigin: "left top",
                      lineHeight: 1.0
                    }}
                  >
                    {obj.text}
                  </span>
                </span>
              ))}
              <style dangerouslySetInnerHTML={{
                __html: `
                .siml-text-node::selection {
                  color: transparent !important;
                  background: rgba(108, 99, 255, 0.35) !important;
                }
              ` }} />
            </div>

            {/* Social Media Strip Simulation Controls */}
            <div style={{ marginTop: "1.5rem", padding: "1.25rem", background: "var(--bg-card)", border: "1px dashed var(--border-accent)", borderRadius: "12px" }}>
              <h3 style={{ fontSize: "0.9375rem", fontWeight: 600, color: "var(--text-primary)", marginBottom: "0.5rem" }}>
                🔥 Social Media Resiliency Test
              </h3>
              <p style={{ fontSize: "0.8125rem", color: "var(--text-secondary)", marginBottom: "1rem" }}>
                Social platforms and CMS optimizers strip metadata chunks (T0). Click below to re-encode this image to a flat metadata-less low-quality JPG and verify survival via T1/T2!
              </p>
              <button className="btn btn-primary" onClick={simulateStripAndRecompress}>
                ⚡ Simulate Platform Strip & Re-compress
              </button>
            </div>
          </div>

          {/* Right panel: Resolver Pipeline logs and layer list */}
          <div className="side-panel">
            {/* Resolution Diagnostics */}
            <div className="panel-card" style={{ background: "var(--bg-secondary)" }}>
              <h3>Resolution Diagnostics</h3>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1rem" }}>
                <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>Active Tier:</span>
                <span className="text-layer-badge" style={{ background: "var(--accent)", color: "white" }}>
                  {activeTier || "Calculating..."}
                </span>
              </div>
              <div style={{ maxHeight: "160px", overflowY: "auto", background: "var(--bg-primary)", padding: "0.75rem", borderRadius: "8px", border: "1px solid var(--border)" }}>
                {resolutionLogs.map((log, i) => (
                  <div key={i} style={{ fontSize: "0.75rem", fontFamily: "monospace", color: log.includes("✅") ? "var(--success)" : "var(--text-secondary)", marginBottom: "0.375rem" }}>
                    {log}
                  </div>
                ))}
              </div>
            </div>

            {/* Extracted Text List */}
            {meta && (
              <div className="panel-card">
                <h3>Selectable Content ({meta.textLayer.length})</h3>
                {meta.textLayer.map((obj) => (
                  <div key={obj.id} className="text-layer-item" style={{ flexDirection: "column", alignItems: "stretch", gap: "0.5rem" }}>
                    {/* Top Row: Badges and Buttons */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
                      <div style={{ display: "flex", gap: "0.375rem" }}>
                        <span className="text-layer-badge">{obj.type}</span>
                        {ACTIONABLE_TYPES.has(obj.type) && (obj.intent || "actionable") === "readonly" && (
                          <span className="text-layer-badge" style={{ background: "var(--bg-secondary)", color: "var(--text-muted)" }} title="Author marked this read-only: no action offered (spec §8.1)">
                            read-only
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: "0.25rem" }}>
                        {isActionEnabled(obj) && (
                          <button
                            className="text-layer-copy"
                            style={{ background: "var(--accent)", color: "white" }}
                            onClick={() => actOn(obj.type, obj.text)}
                          >
                            {actionFor(obj.type, obj.text)?.verb}
                          </button>
                        )}
                        <button className="text-layer-copy" onClick={() => copyText(obj.text, obj.type)}>
                          Copy
                        </button>
                      </div>
                    </div>
                    {/* Bottom Row: Text Content */}
                    <div className="text-layer-text" style={{ wordBreak: "break-word", color: "var(--text-primary)", paddingLeft: "0.25rem" }}>
                      {obj.text}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {toast && (
        <div className="status-bar">
          <div className="toast toast-success">{toast}</div>
        </div>
      )}
    </div>
  );
}
