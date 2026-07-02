/**
 * siml-preserve (JS) - the Level-P hook.
 *
 * Faithful port of the verified Python reference (siml_preserve.py). Copies a
 * SIML layer from a source image to a re-encoded output, byte-for-byte, across
 * PNG / JPEG / WebP, including cross-format (re-wraps into the output's carrier).
 *
 * Detection (carrier-level - no full JUMBF parse needed to COPY):
 *   PNG  : ancillary chunk type  'siMl'
 *   WebP : RIFF chunk FourCC      'siML'
 *   JPEG : APP11 (0xFFEB) segment whose data carries the SIML box UUID
 * SIML box UUID: de6062e1-9e7b-494e-94b3-db6fcc257fdc
 *
 * Safety (matches the hardened Python): explicit bounds checks on every walker,
 * a 4 MiB payload cap (DoS / decompression-bomb guard), and "treat as no layer"
 * on anything malformed - a SIML failure MUST NOT break the host pipeline.
 *
 * Input/output: Node Buffer (or Uint8Array). Pure, synchronous, zero deps.
 */
'use strict';

const SIML_UUID = Buffer.from('de6062e19e7b494e94b3db6fcc257fdc', 'hex');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PAYLOAD = 4 * 1024 * 1024; // 4 MiB hard cap

// --- tiny CRC32 for PNG chunk writing (matches zlib.crc32) ---
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function asBuf(b) {
    return Buffer.isBuffer(b) ? b : Buffer.from(b);
}

function detectFormat(b) {
    if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG)) return 'png';
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
    if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF'
        && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
    throw new Error('unsupported format');
}

// ---------------- PNG ----------------
function pngChunks(b) {
    const out = [];
    let i = 8;
    const n = b.length;
    while (i + 8 <= n) {
        const ln = b.readUInt32BE(i);
        if (ln > MAX_PAYLOAD || i + 12 + ln > n) break; // bounds + cap
        const typ = b.subarray(i + 4, i + 8);
        const data = b.subarray(i + 8, i + 8 + ln);
        const crc = b.subarray(i + 8 + ln, i + 12 + ln);
        out.push({ typ, data, crc });
        i += 12 + ln;
    }
    return out;
}
function pngExtractChunk(b) {
    for (const c of pngChunks(b)) {
        if (c.typ.toString('latin1') === 'siMl') {
            const len = Buffer.alloc(4); len.writeUInt32BE(c.data.length, 0);
            return Buffer.concat([len, c.typ, c.data, c.crc]);
        }
    }
    return null;
}
function pngInject(b, chunk) {
    const parts = [PNG_SIG];
    for (const c of pngChunks(b)) {
        if (c.typ.toString('latin1') === 'IEND') parts.push(chunk); // before IEND
        const len = Buffer.alloc(4); len.writeUInt32BE(c.data.length, 0);
        parts.push(len, c.typ, c.data, c.crc);
    }
    return Buffer.concat(parts);
}
function pngChunkFromPayload(payload) {
    const typ = Buffer.from('siMl', 'latin1');
    const len = Buffer.alloc(4); len.writeUInt32BE(payload.length, 0);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typ, payload])), 0);
    return Buffer.concat([len, typ, payload, crc]);
}

// ---------------- WebP ----------------
function webpChunks(b) {
    const out = [];
    let i = 12;
    const n = b.length;
    while (i + 8 <= n) {
        const fourcc = b.subarray(i, i + 4);
        const ln = b.readUInt32LE(i + 4);
        if (ln > MAX_PAYLOAD || i + 8 + ln > n) break; // bounds + cap
        const data = b.subarray(i + 8, i + 8 + ln);
        out.push({ fourcc, data });
        i += 8 + ln + (ln & 1); // even padding
    }
    return out;
}
function webpInject(b, chunk) {
    const body = Buffer.concat([b.subarray(12), chunk]);
    const size = Buffer.alloc(4); size.writeUInt32LE(body.length + 4, 0);
    return Buffer.concat([Buffer.from('RIFF', 'latin1'), size, Buffer.from('WEBP', 'latin1'), body]);
}
function webpChunkFromPayload(payload) {
    const fourcc = Buffer.from('siML', 'latin1');
    const size = Buffer.alloc(4); size.writeUInt32LE(payload.length, 0);
    let chunk = Buffer.concat([fourcc, size, payload]);
    if (payload.length & 1) chunk = Buffer.concat([chunk, Buffer.from([0])]); // pad
    return chunk;
}

// ---------------- JPEG ----------------
function jpegSegments(b) {
    const out = [];
    let i = 2;
    const n = b.length;
    while (i + 1 < n) {
        if (b[i] !== 0xff) { i += 1; continue; }
        const marker = b[i + 1];
        // standalone markers (no length): SOI, EOI, RSTn
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        if (marker === 0xda) { out.push({ kind: 'SOS', marker, raw: b.subarray(i) }); break; }
        if (i + 4 > n) break;
        const ln = b.readUInt16BE(i + 2);
        if (ln < 2 || i + 2 + ln > n) break; // length includes its own 2 bytes + must fit
        out.push({ kind: 'seg', marker, raw: b.subarray(i, i + 2 + ln) });
        i += 2 + ln;
    }
    return out;
}
function jpegExtractSeg(b) {
    for (const s of jpegSegments(b)) {
        if (s.kind === 'seg' && s.marker === 0xeb && s.raw.includes(SIML_UUID)) return s.raw;
    }
    return null;
}
function jpegInject(b, seg) {
    const parts = [b.subarray(0, 2)]; // SOI
    let inserted = false;
    for (const s of jpegSegments(b)) {
        if (!inserted && s.kind === 'seg') { parts.push(s.raw, seg); inserted = true; }
        else parts.push(s.raw);
    }
    if (!inserted) return Buffer.concat([b.subarray(0, 2), seg, b.subarray(2)]);
    return Buffer.concat(parts);
}
function jpegApp11FromPayload(payload) {
    const data = Buffer.concat([SIML_UUID, payload]);
    const len = Buffer.alloc(2); len.writeUInt16BE(data.length + 2, 0);
    return Buffer.concat([Buffer.from([0xff, 0xeb]), len, data]);
}

// ---------------- raw payload read (cross-format) ----------------
function readPayload(b) {
    b = asBuf(b);
    const f = detectFormat(b);
    let data = null;
    if (f === 'png') {
        for (const c of pngChunks(b)) if (c.typ.toString('latin1') === 'siMl') { data = c.data; break; }
    } else if (f === 'webp') {
        for (const c of webpChunks(b)) if (c.fourcc.toString('latin1') === 'siML') { data = c.data; break; }
    } else if (f === 'jpeg') {
        const seg = jpegExtractSeg(b);
        if (seg) data = seg.subarray(4 + SIML_UUID.length); // strip marker(2)+len(2)+uuid
    }
    if (data && data.length > MAX_PAYLOAD) return null; // bomb guard
    return data;
}

// ---------------- public API ----------------
function hasLayer(b) {
    try { return readPayload(b) !== null; } catch { return false; }
}

function preserve(source, output) {
    source = asBuf(source); output = asBuf(output);
    let payload;
    try { payload = readPayload(source); } catch { return output; }
    if (payload == null) return output;            // nothing to preserve
    if (payload.length > MAX_PAYLOAD) return output;
    let f;
    try { f = detectFormat(output); } catch { return output; } // unknown out fmt → pass through
    try { if (hasLayer(output)) return output; } catch { return output; } // no duplicate
    const make = { png: pngChunkFromPayload, webp: webpChunkFromPayload, jpeg: jpegApp11FromPayload }[f];
    const inject = { png: pngInject, webp: webpInject, jpeg: jpegInject }[f];
    try { return inject(output, make(payload)); } catch { return output; }
}

// helpers exposed for tests / authoring
function injectBox(b, chunk) {
    b = asBuf(b);
    const f = detectFormat(b);
    return { png: pngInject, webp: webpInject, jpeg: jpegInject }[f](b, chunk);
}
const makeChunk = {
    png: pngChunkFromPayload, webp: webpChunkFromPayload, jpeg: jpegApp11FromPayload,
};

module.exports = {
    SIML_UUID, MAX_PAYLOAD,
    detectFormat, hasLayer, readPayload, preserve,
    injectBox, makeChunk, crc32,
};