"use client";

import { useState, useRef, useEffect, MouseEvent } from "react";

interface CanvasTextElement {
  id: string;
  text: string;
  type: "text" | "phone" | "email" | "url" | "address";
  intent: "actionable" | "readonly" | "auto";
  primary?: boolean;
  x: number; // percentage (0-100)
  y: number; // percentage (0-100)
  style: {
    font: string;
    size: number; // pt
    weight: "normal" | "medium" | "bold";
    color: string;
  };
  selectable: boolean;
  label: string | null;
  imported?: boolean;
}

const ACTIONABLE_TYPES = new Set(["url", "phone", "email", "address"]);
const T1_CAPACITY = 16; // watermark payload bytes (spec §4.4/§4.5.1)

// Verify-mode normalization (spec v0.4 draft §4): the checksum is computed
// over a canonical form so OCR whitespace variance can't break verification.
// MUST match the viewer's verifyNormalizations.
function normalizeForVerify(type: string, text: string): string {
  if (type === "phone") return text.replace(/[^+\d]/g, "");
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

// Mirror of siml-writer selectT1Payload (spec §4.5.1). Returns the value to embed
// + mode, or null to skip T1. NEVER truncates - overflow falls back to contentId.
function selectT1Payload(
  els: CanvasTextElement[],
  contentId: string
): { value: string; mode: "direct" | "id" } | null {
  const fits = (str: string) => new TextEncoder().encode(str).length <= T1_CAPACITY;
  const chosen =
    els.find((e) => e.primary === true) ||
    els.find((e) => (e.intent || "actionable") === "actionable" && ACTIONABLE_TYPES.has(e.type));
  if (!chosen) return null;
  if (fits(chosen.text)) return { value: chosen.text, mode: "direct" };
  if (fits(contentId)) return { value: contentId, mode: "id" };
  return null;
}

const SYNC_TAG = 0xD4B3;
const CANONICAL_WIDTH = 1024;
const Q = 26;
const RS_NSYM = 4;  // Reed-Solomon parity symbols (matches writer/rs.js)

// ─── Inline GF(2˸8) RS encoder (mirrors writer/rs.js) ────────────────────────────
const RS_EXP_C = new Uint8Array(512);
const RS_LOG_C = new Uint8Array(256);
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) { RS_EXP_C[i] = x; RS_LOG_C[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) RS_EXP_C[i] = RS_EXP_C[i - 255];
})();
const cRsMul = (a: number, b: number) => (a && b) ? RS_EXP_C[RS_LOG_C[a] + RS_LOG_C[b]] : 0;
const cRsPMulBE = (p: number[], q: number[]) => {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let i = 0; i < p.length; i++) for (let j = 0; j < q.length; j++) r[i+j] ^= cRsMul(p[i], q[j]);
  return r;
};
function cRsEncode(data: number[], nsym: number): number[] {
  let g = [1];
  for (let i = 0; i < nsym; i++) g = cRsPMulBE(g, [1, RS_EXP_C[i]]);
  const msg = [...data, ...new Array(nsym).fill(0)];
  for (let i = 0; i < data.length; i++) {
    if (!msg[i]) continue;
    for (let j = 1; j < g.length; j++) msg[i+j] ^= cRsMul(g[j], msg[i]);
  }
  // Systematic codeword = ORIGINAL data + parity remainder. The division loop
  // mutates the data positions while it runs, so they MUST be restored here
  // (matches writer/rs.js). Returning `msg` directly embeds a corrupted
  // codeword that no decoder can read.
  return [...data, ...msg.slice(data.length)];
}
// ────────────────────────────────────────────────────────────────

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

function idct2d(dctBlock: Float32Array): Float32Array {
  const out = new Float32Array(64);
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let sum = 0;
      for (let u = 0; u < 8; u++) {
        const cu = cCoeff(u);
        const cosX = cosTable[u * 8 + x];
        for (let v = 0; v < 8; v++) {
          sum += cu * cCoeff(v) * dctBlock[u * 8 + v] * cosX * cosTable[v * 8 + y];
        }
      }
      out[x * 8 + y] = 0.25 * sum;
    }
  }
  return out;
}

function embedWatermarkClient(rgba: Uint8ClampedArray, width: number, height: number, payloadBytes: Uint8Array) {
  // Callers supply the exact payload bytes: 16 NUL-padded bytes for direct/id
  // mode (spec §4.5.1, never truncated) or 6 bytes ("V1" + CRC32) for verify
  // mode (spec v0.4 draft). Shorter payload = shorter bitstream = more
  // repetitions per bit = deeper survival.

  // CRC → RS-encode([payload ‖ CRC_hi ‖ CRC_lo])
  const crc = crc16(payloadBytes);
  const rsInput = [...Array.from(payloadBytes), (crc >> 8) & 0xFF, crc & 0xFF];
  const rsCoded = cRsEncode(rsInput, RS_NSYM);

  const bits: number[] = [];
  for (let i = 0; i < 16; i++) bits.push((SYNC_TAG >> (15 - i)) & 1);
  for (const byte of rsCoded) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);

  // Multiple passes fight saturation clipping on near-white/near-black content:
  // clamped pixels drag the coefficient off its level; re-embedding on the
  // clamped result re-pushes those blocks. Decoder-independent, so no §4.4
  // desync trap. MUST match siml-writer/src/watermark.js.
  const EMBED_PASSES = 3;
  for (let pass = 0; pass < EMBED_PASSES; pass++) embedPassClient(rgba, width, height, bits);
}

function embedPassClient(rgba: Uint8ClampedArray, width: number, height: number, bits: number[]) {
  const Y = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++)
    Y[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];

  const blocksX = Math.floor(width / 8);
  const blocksY = Math.floor(height / 8);
  const bitLength = bits.length;
  let bitIndex = 0;
  const block = new Float32Array(64);

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      for (let x = 0; x < 8; x++)
        for (let y = 0; y < 8; y++)
          block[x * 8 + y] = Y[((by * 8 + x) * width) + (bx * 8 + y)];

      const dct = dct2d(block);
      const targetBit = bits[bitIndex % bitLength];
      const coeffVal = dct[2 * 8 + 1];
      // QIM levels every Q with the bit in the level's parity (decision margin
      // Q/2, matching the validated reference). MUST match siml-writer.
      let quantum = Math.round(coeffVal / Q);
      const isEven = ((quantum % 2) + 2) % 2 === 0;
      if (isEven !== (targetBit === 0)) {
        quantum += (coeffVal / Q - quantum) >= 0 ? 1 : -1;
      }
      dct[2 * 8 + 1] = quantum * Q;
      const reconstructed = idct2d(dct);
      for (let x = 0; x < 8; x++)
        for (let y = 0; y < 8; y++)
          Y[((by * 8 + x) * width) + (bx * 8 + y)] = reconstructed[x * 8 + y];
      bitIndex++;
    }
  }

  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const oldY = 0.299 * r + 0.587 * g + 0.114 * b;
    const delta = Y[i] - oldY;
    rgba[i * 4]     = Math.max(0, Math.min(255, r + delta));
    rgba[i * 4 + 1] = Math.max(0, Math.min(255, g + delta));
    rgba[i * 4 + 2] = Math.max(0, Math.min(255, b + delta));
  }
}

// 256-bit DCT pHash (spec §5.2) - MUST match siml-writer/src/fingerprint.js.
const PH_SIZE = 32;
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

// 256-bit pHash of a 32×32 greyscale - shared DCT-hash core (§5.2 / §5.3.1).
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

// Region hash (spec §5.3.1) from a source canvas - crop the %-bounds region (same
// margin as reader/writer), downscale to 32×32 greyscale, pHash.
function regionHashFromCanvas(src: HTMLCanvasElement, b: { x: number; y: number; w: number; h: number }): string | null {
  try {
    const W = src.width, H = src.height;
    const padX = 2, padY = 4;
    let left = Math.round(((b.x - padX) / 100) * W);
    let top = Math.round(((b.y - padY) / 100) * H);
    let cw = Math.round(((b.w + 2 * padX) / 100) * W);
    let ch = Math.round(((b.h + 2 * padY) / 100) * H);
    left = Math.max(0, Math.min(left, W - 1)); top = Math.max(0, Math.min(top, H - 1));
    cw = Math.max(1, Math.min(cw, W - left)); ch = Math.max(1, Math.min(ch, H - top));
    const c = document.createElement("canvas"); c.width = PH_SIZE; c.height = PH_SIZE;
    const cx = c.getContext("2d")!; cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = "high";
    cx.drawImage(src, left, top, cw, ch, 0, 0, PH_SIZE, PH_SIZE);
    const data = cx.getImageData(0, 0, PH_SIZE, PH_SIZE).data;
    const grey = new Float64Array(PH_SIZE * PH_SIZE);
    for (let i = 0; i < PH_SIZE * PH_SIZE; i++)
      grey[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    return pHashGrey32(grey);
  } catch { return null; }
}

// ─── Browser Binary Injection Helpers ───
function concatBytes(arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const arr of arrays) total += arr.length;
  const res = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    res.set(arr, offset);
    offset += arr.length;
  }
  return res;
}

const makeCRCTable = () => {
  let c;
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) {
      c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
    }
    crcTable[n] = c;
  }
  return crcTable;
};
const crcTable = makeCRCTable();

function computeCRC32(bytes: Uint8Array): number {
  let crc = 0 ^ (-1);
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

function writeUInt32BE(bytes: Uint8Array, offset: number, val: number) {
  bytes[offset] = (val >>> 24) & 0xFF;
  bytes[offset + 1] = (val >>> 16) & 0xFF;
  bytes[offset + 2] = (val >>> 8) & 0xFF;
  bytes[offset + 3] = val & 0xFF;
}

function serializeJUMBF(jsonObject: any): Uint8Array {
  const SIML_UUID = new Uint8Array([
    0xDE, 0x60, 0x62, 0xE1, 0x9E, 0x7B, 0x49, 0x4E, 0x94, 0xB3, 0xDB, 0x6F, 0xCC, 0x25, 0x7F, 0xDC
  ]);
  const jsonStr = JSON.stringify(jsonObject);
  const payloadBytes = new TextEncoder().encode(jsonStr);

  const label = "siml\0";
  const jumbdLength = 4 + 4 + 16 + 1 + label.length;
  const jumbd = new Uint8Array(jumbdLength);
  const jumbdView = new DataView(jumbd.buffer);
  
  jumbdView.setUint32(0, jumbdLength, false);
  jumbd.set([106, 117, 109, 98, 100], 4);
  jumbd.set(SIML_UUID, 8);
  jumbd[24] = 0x03;
  for (let i = 0; i < label.length; i++) jumbd[25 + i] = label.charCodeAt(i);

  const jsonBoxLength = 4 + 4 + payloadBytes.length;
  const jsonBox = new Uint8Array(8 + payloadBytes.length);
  const jsonBoxView = new DataView(jsonBox.buffer);
  jsonBoxView.setUint32(0, jsonBoxLength, false);
  jsonBox.set([106, 115, 111, 110], 4);
  jsonBox.set(payloadBytes, 8);

  const superboxLength = 4 + 4 + jumbd.length + jsonBox.length;
  const superbox = new Uint8Array(8);
  const superboxView = new DataView(superbox.buffer);
  superboxView.setUint32(0, superboxLength, false);
  superbox.set([106, 117, 109, 98], 4);

  return concatBytes([superbox, jumbd, jsonBox]);
}

function injectPNG(buf: Uint8Array, payload: Uint8Array): Uint8Array {
  const chunkHeader = new Uint8Array(8);
  writeUInt32BE(chunkHeader, 0, payload.length);
  chunkHeader[4] = 115; chunkHeader[5] = 105; chunkHeader[6] = 77; chunkHeader[7] = 108; // 'siMl'

  const typeAndData = new Uint8Array(4 + payload.length);
  typeAndData.set(chunkHeader.subarray(4, 8), 0);
  typeAndData.set(payload, 4);

  const chunkCRC = new Uint8Array(4);
  writeUInt32BE(chunkCRC, 0, computeCRC32(typeAndData));
  const newChunk = concatBytes([chunkHeader, payload, chunkCRC]);

  let pos = 8;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (pos < buf.length) {
    if (pos + 8 > buf.length) break;
    const length = view.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    const chunkTotalSize = 4 + 4 + length + 4;

    if (type === 'IEND') {
      const head = buf.subarray(0, pos);
      const tail = buf.subarray(pos);
      return concatBytes([head, newChunk, tail]);
    }
    pos += chunkTotalSize;
  }
  return concatBytes([buf, newChunk]);
}

// ─── T0 JUMBF Parsing (for importing existing SIML) ───
const PARSER_SIML_UUID = new Uint8Array([
  0xDE, 0x60, 0x62, 0xE1, 0x9E, 0x7B, 0x49, 0x4E, 0x94, 0xB3, 0xDB, 0x6F, 0xCC, 0x25, 0x7F, 0xDC
]);
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
        const match = PARSER_SIML_UUID.every((b, i) => uuid[i] === b);
        if (!match) return null;
      } else if (boxType === 'json') {
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
function extractMetadata(arrayBuffer: ArrayBuffer): any | null {
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

export default function CreatePage() {
  const [template, setTemplate] = useState<"dark" | "gradient" | "uploaded">("gradient");
  const [uploadedImageURL, setUploadedImageURL] = useState<string | null>(null);
  const [elements, setElements] = useState<CanvasTextElement[]>([
    {
      id: "e1",
      text: "SIML v0.3 Premium Designer",
      type: "text",
      intent: "auto",
      x: 10,
      y: 18,
      style: { font: "Playfair Display", size: 36, weight: "bold", color: "#FFFFFF" },
      selectable: true,
      label: null
    },
    {
      id: "e2",
      text: "+91-98765-43210",
      type: "phone",
      intent: "actionable",
      primary: true,
      x: 10,
      y: 50,
      style: { font: "Inter", size: 18, weight: "medium", color: "#2dd4a8" },
      selectable: true,
      label: "Call Agent"
    },
    {
      id: "e3",
      text: "https://siml-spec.org",
      type: "url",
      intent: "actionable",
      x: 10,
      y: 65,
      style: { font: "Inter", size: 16, weight: "normal", color: "#6c63ff" },
      selectable: true,
      label: "Visit Docs"
    }
  ]);
  const [selectedId, setSelectedId] = useState<string | null>("e1");
  const [writeT1, setWriteT1] = useState(true);
  const [t1VerifyMode, setT1VerifyMode] = useState(false);
  const [writeT2, setWriteT2] = useState(true);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(4);

  // Dragging support variables
  const dragStart = useRef<{ x: number; y: number; elX: number; elY: number } | null>(null);

  const [scale, setScale] = useState(1);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        setScale(width / 1024);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  function showToast(msg: string, type = "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  function addTextElement() {
    const id = `e${nextId.current++}`;
    const newElement: CanvasTextElement = {
      id,
      text: "Double-click to edit",
      type: "text",
      intent: "auto",
      x: 30,
      y: 40,
      style: { font: "Inter", size: 20, weight: "normal", color: "#FFFFFF" },
      selectable: true,
      label: null
    };
    setElements([...elements, newElement]);
    setSelectedId(id);
  }

  function updateSelectedElement(updates: Partial<CanvasTextElement>) {
    if (!selectedId) return;
    setElements(elements.map(e => {
      if (e.id === selectedId) {
        const next = { ...e, ...updates };
        if (updates.text !== undefined && updates.text !== e.text) {
          next.imported = false;
        }
        return next;
      }
      return e;
    }));
  }

  // At most one primary per layer (spec §8): marking one clears the others.
  function setSelectedPrimary(on: boolean) {
    if (!selectedId) return;
    setElements(elements.map(e => ({ ...e, primary: e.id === selectedId ? on : false })));
  }

  function updateSelectedStyle(updates: Partial<CanvasTextElement["style"]>) {
    if (!selectedId) return;
    setElements(elements.map(e => e.id === selectedId ? { ...e, style: { ...e.style, ...updates } } : e));
  }

  function deleteSelectedElement() {
    if (!selectedId) return;
    setElements(elements.filter(e => e.id !== selectedId));
    setSelectedId(null);
  }

  function handleMouseDown(e: MouseEvent, el: CanvasTextElement) {
    e.stopPropagation();
    setSelectedId(el.id);
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    
    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      elX: el.x,
      elY: el.y
    };
  }

  function handleMouseMove(e: MouseEvent) {
    if (!dragStart.current || !selectedId) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    const deltaX = ((e.clientX - dragStart.current.x) / rect.width) * 100;
    const deltaY = ((e.clientY - dragStart.current.y) / rect.height) * 100;

    let nextX = dragStart.current.elX + deltaX;
    let nextY = dragStart.current.elY + deltaY;

    nextX = Math.max(0, Math.min(95, nextX));
    nextY = Math.max(0, Math.min(95, nextY));

    setElements(prev => prev.map(el => el.id === selectedId ? {
      ...el,
      x: parseFloat(nextX.toFixed(2)),
      y: parseFloat(nextY.toFixed(2))
    } : el));
  }

  function handleMouseUp() {
    dragStart.current = null;
  }

  async function handleImageUpload(file: File) {
    const url = URL.createObjectURL(file);
    setUploadedImageURL(url);
    setTemplate("uploaded");

    try {
      const arrayBuffer = await file.arrayBuffer();
      const meta = extractMetadata(arrayBuffer);
      if (meta && meta.textLayer && Array.isArray(meta.textLayer)) {
        const importedElements: CanvasTextElement[] = meta.textLayer.map((obj: any, idx: number) => ({
          id: obj.id || `e${idx + 1}`,
          text: obj.text || "",
          type: obj.type || "text",
          intent: obj.intent || "auto",
          primary: !!obj.primary,
          x: typeof obj.bounds?.x === "number" ? obj.bounds.x : 10,
          y: typeof obj.bounds?.y === "number" ? obj.bounds.y : 10,
          style: {
            font: obj.style?.font || "Inter",
            size: typeof obj.style?.size === "number" ? obj.style.size : 16,
            weight: obj.style?.weight || "normal",
            color: obj.style?.color || "#FFFFFF"
          },
          selectable: obj.selectable !== false,
          label: obj.label || null,
          imported: true
        }));

        if (importedElements.length > 0) {
          setElements(importedElements);
          
          let maxNum = 0;
          importedElements.forEach(e => {
            const match = e.id.match(/\d+/);
            if (match) {
              const num = parseInt(match[0]);
              if (num > maxNum) maxNum = num;
            }
          });
          nextId.current = maxNum + 1;
          setSelectedId(importedElements[0].id);
          showToast(`📥 Imported ${importedElements.length} existing SIML objects!`, "success");
        }
      }
    } catch (err) {
      console.warn("Failed to parse existing SIML from upload:", err);
    }
  }

  async function handleExport() {
    try {
      // 1. Create design canvas sized at 1024x512
      const canvas = document.createElement("canvas");
      canvas.width = 1024;
      canvas.height = 512;
      const ctx = canvas.getContext("2d")!;

      // 2. Draw template backgrounds
      if (template === "gradient") {
        const grad = ctx.createLinearGradient(0, 0, 1024, 512);
        grad.addColorStop(0, "#0f0c1b");
        grad.addColorStop(0.5, "#6c63ff");
        grad.addColorStop(1, "#2dd4a8");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 1024, 512);
      } else if (template === "dark") {
        ctx.fillStyle = "#0a0a0f";
        ctx.fillRect(0, 0, 1024, 512);
        // glowing circles
        ctx.fillStyle = "rgba(108, 99, 255, 0.15)";
        ctx.beginPath(); ctx.arc(800, 100, 300, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "rgba(45, 212, 168, 0.12)";
        ctx.beginPath(); ctx.arc(150, 400, 250, 0, Math.PI * 2); ctx.fill();
        // border frame glow
        ctx.strokeStyle = "#6c63ff";
        ctx.lineWidth = 8;
        ctx.strokeRect(0, 0, 1024, 512);
      } else if (template === "uploaded" && uploadedImageURL) {
        const img = new Image();
        img.src = uploadedImageURL;
        await new Promise(r => img.onload = r);
        ctx.drawImage(img, 0, 0, 1024, 512);
      }

      // 3. Draw text layers to canvas (burning pixels) - skip elements that are already imported (already in the image pixels)
      for (const el of elements) {
        if (el.imported) continue;
        ctx.fillStyle = el.style.color;
        const fontName = el.style.font === "Playfair Display" ? "Playfair Display" : el.style.font;
        ctx.font = `${el.style.weight === "medium" ? "500" : el.style.weight} ${el.style.size * 1.5}px ${fontName}, sans-serif`;
        ctx.textBaseline = "top";
        
        const px = (el.x / 100) * 1024;
        const py = (el.y / 100) * 512;
        ctx.fillText(el.text, px, py);
      }

      const imgData = ctx.getImageData(0, 0, 1024, 512);
      const contentId = `siml-${Date.now()}`;

      // 4. Tier 1: select the one field T1 carries (spec §4.5.1 - primary →
      // actionable → skip), never truncating. Overflow falls back to id mode.
      // Verify mode (spec v0.4 draft) embeds a 6-byte checksum of the field
      // instead of the field itself; the viewer recovers the exact text and
      // its true position via OCR + oracle search.
      let t1Mode: "direct" | "id" | "verify" | null = null;
      if (writeT1) {
        const chosen =
          elements.find((e) => e.primary === true) ||
          elements.find((e) => (e.intent || "actionable") === "actionable" && ACTIONABLE_TYPES.has(e.type));
        const sel = selectT1Payload(elements, contentId);
        if (t1VerifyMode && chosen) {
          const norm = normalizeForVerify(chosen.type, chosen.text);
          const crc = computeCRC32(new TextEncoder().encode(norm));
          const p = new Uint8Array(6);
          p[0] = 0x56; p[1] = 0x31; // "V1"
          p[2] = (crc >>> 24) & 0xFF; p[3] = (crc >>> 16) & 0xFF;
          p[4] = (crc >>> 8) & 0xFF; p[5] = crc & 0xFF;
          embedWatermarkClient(imgData.data, 1024, 512, p);
          ctx.putImageData(imgData, 0, 0);
          t1Mode = "verify";
        } else if (sel) {
          const payloadBytes = new Uint8Array(16); // NUL-padded, never truncated
          payloadBytes.set(new TextEncoder().encode(sel.value));
          embedWatermarkClient(imgData.data, 1024, 512, payloadBytes);
          ctx.putImageData(imgData, 0, 0);
          t1Mode = sel.mode;
        } else {
          showToast("No watermark-eligible field - T1 skipped (T0/T2 still written).");
        }
      }
      const t1Written = t1Mode !== null;

      // pixelDigest (spec §9.3): hash the FINAL pixels (post-T1) so re-export of an
      // edited image carries a fresh digest. The reader recomputes & compares.
      const finalPixels = ctx.getImageData(0, 0, 1024, 512);
      const pixelDigest = calculatePHashClient(finalPixels.data, 1024, 512);

      // Convert canvas to Blob
      const blob: Blob = await new Promise((resolve) => {
        canvas.toBlob((b) => resolve(b!), "image/png");
      });

      const buffer = new Uint8Array(await blob.arrayBuffer());

      // Assemble TextLayer with bounding box calculations
      // Measure character sizes to construct a mock single text layer runs structure
      const finalLayers = elements.map(el => {
        // Measure text size in Canvas
        const fontName = el.style.font === "Playfair Display" ? "Playfair Display" : el.style.font;
        ctx.font = `${el.style.weight === "medium" ? "500" : el.style.weight} ${el.style.size * 1.5}px ${fontName}, sans-serif`;
        const metrics = ctx.measureText(el.text);
        const wPercent = (metrics.width / 1024) * 100;
        const hPercent = ((el.style.size * 1.5) / 512) * 100;

        const bounds = {
          x: el.x,
          y: el.y,
          w: parseFloat(wPercent.toFixed(2)),
          h: parseFloat(hPercent.toFixed(2))
        };

        return {
          id: el.id,
          text: el.text,
          type: el.type,
          // Only meaningful for actionable types; omit for plain text to keep
          // payloads clean (reader defaults absent intent to 'actionable').
          ...(ACTIONABLE_TYPES.has(el.type) ? { intent: el.intent } : {}),
          ...(el.primary ? { primary: true } : {}),
          bounds,
          runs: [{ bounds, text: el.text }],
          style: el.style,
          selectable: el.selectable,
          label: el.label
        };
      });

      // 5. Tier 2: Register Perceptual hash (localStorage + HTTP registry for cross-session)
      if (writeT2) {
        const dhash = calculatePHashClient(imgData.data, 1024, 512);
        // Region hash (spec §5.3.1): fingerprint the distinguishing field's bounds
        // so near-duplicate templates are separable at verification time.
        const regionObj =
          finalLayers.find(l => (l as any).primary) ||
          finalLayers.find(l => ACTIONABLE_TYPES.has(l.type) && (l as any).intent !== "readonly") ||
          finalLayers.find(l => l.selectable);
        const regionBounds = regionObj?.bounds;
        const regionHash = regionBounds ? regionHashFromCanvas(canvas, regionBounds) : null;
        const t2Payload = {
          siml: "0.3",
          contentId,
          pixelDigest,
          ...(regionHash ? { regionHash, regionBounds } : {}),
          image: { width: 1024, height: 512 },
          permissions: { platformCanDisableSelection: true, platformCanDisableLinks: true, platformCanDisableAll: false },
          textLayer: finalLayers
        };
        // Local fallback
        let localRegistry: Record<string, any> = {};
        try { localRegistry = JSON.parse(localStorage.getItem("siml-registry") || "{}"); } catch (e) {}
        localRegistry[dhash] = t2Payload;
        localStorage.setItem("siml-registry", JSON.stringify(localRegistry));
        // HTTP registry (persists across sessions / tabs)
        try {
          await fetch('/api/registry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hash: dhash, payload: t2Payload })
          });
        } catch (e) { /* offline - localStorage fallback is sufficient */ }
      }

      // Assemble JUMBF payload
      const metaJson = {
        siml: "0.3",
        contentId,
        pixelDigest,
        binding: {
          t0: true,
          t1: t1Written,
          t2: writeT2,
          ...(t1Written ? { payloadMode: t1Mode, canonicalWidth: 1024 } : {}),
        },
        image: { width: 1024, height: 512 },
        permissions: {
          platformCanDisableSelection: true,
          platformCanDisableLinks: true,
          platformCanDisableAll: false
        },
        textLayer: finalLayers
      };

      // 6. Tier 0: Inject JUMBF Superbox
      const modifiedBytes = injectPNG(buffer, serializeJUMBF(metaJson));
      const finalBlob = new Blob([modifiedBytes as any], { type: "image/png" });

      // Trigger download
      const downloadURL = URL.createObjectURL(finalBlob);
      const a = document.createElement("a");
      a.href = downloadURL;
      a.download = `flat-design.siml.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadURL);

      showToast(`SIML v0.3 Carrier exported successfully! written tiers: T0 ${writeT1 ? "+ T1" : ""} ${writeT2 ? "+ T2" : ""}`);
    } catch (e) {
      showToast(`Export failed: ${(e as Error).message}`, "error");
    }
  }

  return (
    <div className="page" onMouseMove={handleMouseMove} onMouseUp={handleMouseUp}>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1>SIML Visual Canvas Editor</h1>
          <p>Design visual text cards, burn them into flat image pixels, and embed selectable SIML v0.3 metadata</p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button className="btn btn-secondary btn-sm" onClick={addTextElement}>+ Add Text Element</button>
          <button className="btn btn-primary btn-sm" onClick={handleExport}>↓ Export Flattened SIML</button>
        </div>
      </div>

      <div className="annotation-workspace">
        {/* Editor Main Canvas Workspace */}
        <div 
          ref={containerRef}
          className="canvas-container"
          style={{
            width: "100%",
            aspectRatio: "2 / 1",
            background: template === "dark" ? "#0a0a0f" : undefined,
            position: "relative",
            border: "1px solid var(--border)",
            borderRadius: "12px",
            boxShadow: "0 10px 40px rgba(0,0,0,0.4)",
            cursor: "default"
          }}
        >
          {/* Neon gradient background */}
          {template === "gradient" && (
            <div style={{
              position: "absolute",
              inset: 0,
              background: "linear-gradient(135deg, #0f0c1b 0%, #6c63ff 50%, #2dd4a8 100%)",
              zIndex: 0
            }} />
          )}

          {/* Dark glowing circles template background */}
          {template === "dark" && (
            <div style={{ position: "absolute", inset: 0, zIndex: 0, overflow: "hidden" }}>
              <div style={{ position: "absolute", width: "600px", height: "600px", background: "rgba(108, 99, 255, 0.15)", filter: "blur(80px)", borderRadius: "50%", right: "-100px", top: "-100px" }} />
              <div style={{ position: "absolute", width: "500px", height: "500px", background: "rgba(45, 212, 168, 0.12)", filter: "blur(80px)", borderRadius: "50%", left: "-100px", bottom: "-100px" }} />
              <div style={{ position: "absolute", inset: 0, border: "4px solid rgba(108, 99, 255, 0.3)", borderRadius: "12px" }} />
            </div>
          )}

          {/* Uploaded template background */}
          {template === "uploaded" && uploadedImageURL && (
            <img
              src={uploadedImageURL}
              alt="Uploaded template background"
              // objectFit fill, not cover: export stretches the background to the
              // 1024x512 canvas, so the preview must show the same mapping or the
              // burned text would land somewhere else than the author saw.
              style={{ width: "100%", height: "100%", objectFit: "fill", position: "absolute", inset: 0, zIndex: 0 }}
            />
          )}

          {/* Text Element Overlays */}
          {elements.map((el) => (
            <div
              key={el.id}
              style={{
                position: "absolute",
                left: `${el.x}%`,
                top: `${el.y}%`,
                fontFamily: el.style.font,
                fontSize: `${el.style.size * 1.5 * scale}px`,
                fontWeight: el.style.weight === "medium" ? "500" : el.style.weight,
                color: el.imported ? "transparent" : el.style.color,
                cursor: "move",
                userSelect: "none",
                zIndex: 10,
                border: selectedId === el.id 
                  ? "1.5px dashed var(--accent)" 
                  : (el.imported ? "1px dashed rgba(255, 255, 255, 0.25)" : "1.5px dashed transparent"),
                padding: 0,
                lineHeight: 1.0
              }}
              onMouseDown={(e) => handleMouseDown(e, el)}
            >
              {el.text}
            </div>
          ))}
        </div>

        {/* Sidebar Configuration */}
        <div className="side-panel">
          {/* Template Selector */}
          <div className="panel-card">
            <h3>Background Template</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              <button 
                className={`btn btn-sm ${template === "gradient" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setTemplate("gradient")}
              >
                Vibrant Gradient
              </button>
              <button 
                className={`btn btn-sm ${template === "dark" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setTemplate("dark")}
              >
                Premium Tech Card
              </button>
              <button 
                className="btn btn-secondary btn-sm"
                onClick={() => fileInputRef.current?.click()}
              >
                Upload Background
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleImageUpload(file);
                }}
              />
            </div>
          </div>

          {/* Selected Text Styling Controls */}
          {selectedId && (
            <div className="panel-card">
              <h3>Style selected text</h3>
              {elements.find(e => e.id === selectedId) && (
                <div>
                  <div className="form-group">
                    <label className="form-label">Content</label>
                    <input
                      className="form-input"
                      type="text"
                      value={elements.find(e => e.id === selectedId)!.text}
                      onChange={(e) => updateSelectedElement({ text: e.target.value })}
                    />
                  </div>

                  <div className="form-row">
                    <div className="form-group">
                      <label className="form-label">Font Family</label>
                      <select 
                        className="form-select"
                        value={elements.find(e => e.id === selectedId)!.style.font}
                        onChange={(e) => updateSelectedStyle({ font: e.target.value })}
                      >
                        <option value="Inter">Inter</option>
                        <option value="Playfair Display">Playfair Display</option>
                        <option value="Montserrat">Montserrat</option>
                        <option value="Roboto">Roboto</option>
                        <option value="Georgia">Georgia</option>
                      </select>
                    </div>

                    <div className="form-group">
                      <label className="form-label">Weight</label>
                      <select
                        className="form-select"
                        value={elements.find(e => e.id === selectedId)!.style.weight}
                        onChange={(e) => updateSelectedStyle({ weight: e.target.value as any })}
                      >
                        <option value="normal">Regular</option>
                        <option value="medium">Medium</option>
                        <option value="bold">Bold</option>
                      </select>
                    </div>
                  </div>

                  <div className="form-row">
                    <div className="form-group">
                      <label className="form-label">Font Size (px)</label>
                      <input
                        className="form-input"
                        type="number"
                        min="12"
                        max="80"
                        value={elements.find(e => e.id === selectedId)!.style.size}
                        onChange={(e) => updateSelectedStyle({ size: parseInt(e.target.value) || 16 })}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Color</label>
                      <select
                        className="form-select"
                        value={elements.find(e => e.id === selectedId)!.style.color}
                        onChange={(e) => updateSelectedStyle({ color: e.target.value })}
                      >
                        <option value="#FFFFFF">White</option>
                        <option value="#2dd4a8">Turquoise</option>
                        <option value="#6c63ff">Accent Purple</option>
                        <option value="#fbbf24">Warning Gold</option>
                        <option value="#f87171">Danger Red</option>
                      </select>
                    </div>
                  </div>

                  <div className="form-row">
                    <div className="form-group">
                      <label className="form-label">Type</label>
                      <select
                        className="form-select"
                        value={elements.find(e => e.id === selectedId)!.type}
                        onChange={(e) => updateSelectedElement({ type: e.target.value as any })}
                      >
                        <option value="text">text</option>
                        <option value="phone">phone</option>
                        <option value="url">url</option>
                        <option value="email">email</option>
                        <option value="address">address</option>
                      </select>
                    </div>

                    <div className="form-group">
                      <label className="form-label">Label</label>
                      <input
                        className="form-input"
                        type="text"
                        placeholder="Action label"
                        value={elements.find(e => e.id === selectedId)!.label || ""}
                        onChange={(e) => updateSelectedElement({ label: e.target.value || null })}
                      />
                    </div>
                  </div>

                  {/* Intent - only meaningful for actionable types (spec §8.1) */}
                  {ACTIONABLE_TYPES.has(elements.find(e => e.id === selectedId)!.type) && (
                    <div className="form-group">
                      <label className="form-label">
                        Action Intent
                        <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> - what the platform is asked to offer</span>
                      </label>
                      <select
                        className="form-select"
                        value={elements.find(e => e.id === selectedId)!.intent}
                        onChange={(e) => updateSelectedElement({ intent: e.target.value as any })}
                      >
                        <option value="actionable">actionable - offer Call/Open/Email/Directions</option>
                        <option value="readonly">read-only - copy/select only, don&apos;t offer the action</option>
                        <option value="auto">auto - let the platform decide</option>
                      </select>
                    </div>
                  )}

                  {/* primary - the one field the T1 watermark carries (spec §4.5.1) */}
                  <div className="form-group" style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.25rem" }}>
                    <input
                      type="checkbox"
                      id="primaryFlag"
                      checked={!!elements.find(e => e.id === selectedId)!.primary}
                      onChange={(e) => setSelectedPrimary(e.target.checked)}
                      style={{ cursor: "pointer" }}
                    />
                    <label htmlFor="primaryFlag" style={{ fontSize: "0.8125rem", cursor: "pointer" }}>
                      Watermark this field <span style={{ color: "var(--text-muted)" }}>(primary - what T1 embeds; one per image)</span>
                    </label>
                  </div>

                  <button className="btn btn-secondary btn-danger btn-sm" style={{ width: "100%", marginTop: "1rem" }} onClick={deleteSelectedElement}>
                    Delete Element
                  </button>
                </div>
              )}
            </div>
          )}

          {/* SIML Tiers Configurator */}
          <div className="panel-card">
            <h3>SIML v0.3 Resilient Tiers</h3>
            
            <div className="form-group" style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
              <input type="checkbox" checked disabled id="tier0" style={{ cursor: "not-allowed" }} />
              <label htmlFor="tier0" style={{ fontSize: "0.8125rem", fontWeight: 600 }}>T0: JUMBF Container (Always)</label>
            </div>

            <div className="form-group" style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
              <input 
                type="checkbox" 
                checked={writeT1} 
                onChange={(e) => setWriteT1(e.target.checked)} 
                id="tier1" 
                style={{ cursor: "pointer" }}
              />
              <label htmlFor="tier1" style={{ fontSize: "0.8125rem", fontWeight: 600, cursor: "pointer" }}>T1: Pixel Watermark (alters pixels imperceptibly)</label>
            </div>

            <div className="form-group" style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem", paddingLeft: "1.25rem", opacity: writeT1 ? 1 : 0.45 }}>
              <input
                type="checkbox"
                checked={t1VerifyMode}
                disabled={!writeT1}
                onChange={(e) => setT1VerifyMode(e.target.checked)}
                id="tier1verify"
                style={{ cursor: writeT1 ? "pointer" : "not-allowed" }}
              />
              <label htmlFor="tier1verify" style={{ fontSize: "0.78rem", cursor: writeT1 ? "pointer" : "not-allowed" }}>
                Verify mode (v0.4 experimental): embed a checksum instead of the value;
                the viewer proves the visible text exact via OCR and recovers its true position
              </label>
            </div>

            <div className="form-group" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input 
                type="checkbox" 
                checked={writeT2} 
                onChange={(e) => setWriteT2(e.target.checked)} 
                id="tier2" 
                style={{ cursor: "pointer" }}
              />
              <label htmlFor="tier2" style={{ fontSize: "0.8125rem", fontWeight: 600, cursor: "pointer" }}>T2: Fingerprint Registry</label>
            </div>

            <p style={{ fontSize: "0.6875rem", color: "var(--text-muted)", marginTop: "0.75rem", lineHeight: 1.4 }}>
              Tier 1 embeds the payload in the luminance channel: an invisible but real pixel
              change (about 39 dB PSNR), traded for offline re-encode survival. Uncheck it for a
              byte-exact raster. Tier 2 registers an appearance hash with the resolver; it never
              alters pixels.
            </p>
          </div>
        </div>
      </div>

      {toast && (
        <div className="status-bar">
          <div className={`toast toast-${toast.type}`}>{toast.msg}</div>
        </div>
      )}
    </div>
  );
}
