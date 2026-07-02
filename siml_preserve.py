"""
siml-preserve : the Level-P hook. Copy a SIML layer from a source image to a
re-encoded output, byte-for-byte, across PNG / JPEG / WebP.

Detection (carrier-level, no full JUMBF parse needed to COPY):
  PNG  : ancillary chunk type  b'siMl'
  WebP : RIFF chunk FourCC      b'siML'
  JPEG : APP11 (0xFFEB) segment whose data carries the SIML box UUID
The SIML box UUID:  de6062e1-9e7b-494e-94b3-db6fcc257fdc
"""
import struct, zlib

SIML_UUID = bytes.fromhex("de6062e19e7b494e94b3db6fcc257fdc")
MAX_PAYLOAD = 4 * 1024 * 1024   # 4 MiB hard cap (DoS / bomb guard)
PNG_SIG = b"\x89PNG\r\n\x1a\n"

def detect_format(b: bytes) -> str:
    if b[:8] == PNG_SIG: return "png"
    if b[:2] == b"\xff\xd8": return "jpeg"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP": return "webp"
    raise ValueError("unsupported format")

# ---------------- PNG ----------------
def _png_chunks(b):
    i = 8; out = []
    n = len(b)
    while i + 8 <= n:
        ln = struct.unpack(">I", b[i:i+4])[0]
        if ln > MAX_PAYLOAD or i + 12 + ln > n:   # declared length must fit + be sane
            break
        typ = b[i+4:i+8]; data = b[i+8:i+8+ln]; crc = b[i+8+ln:i+12+ln]
        out.append((typ, data, crc)); i += 12 + ln
    return out

def _png_extract(b):
    for typ, data, crc in _png_chunks(b):
        if typ == b"siMl":
            return struct.pack(">I", len(data)) + typ + data + crc
    return None

def _png_inject(b, chunk):
    chunks = _png_chunks(b)
    out = bytearray(PNG_SIG)
    for typ, data, crc in chunks:
        if typ == b"IEND":
            out += chunk                                   # insert before IEND
        out += struct.pack(">I", len(data)) + typ + data + crc
    return bytes(out)

def make_png_chunk(payload: bytes):
    typ = b"siMl"
    return struct.pack(">I", len(payload)) + typ + payload + struct.pack(">I", zlib.crc32(typ+payload) & 0xffffffff)

# ---------------- WebP ----------------
def _webp_chunks(b):
    i = 12; out = []
    n = len(b)
    while i + 8 <= n:
        fourcc = b[i:i+4]; ln = struct.unpack("<I", b[i+4:i+8])[0]
        if ln > MAX_PAYLOAD or i + 8 + ln > n:
            break
        data = b[i+8:i+8+ln]; pad = ln & 1
        out.append((fourcc, data)); i += 8 + ln + pad
    return out

def _webp_extract(b):
    for fourcc, data in _webp_chunks(b):
        if fourcc == b"siML":
            chunk = fourcc + struct.pack("<I", len(data)) + data
            if len(data) & 1: chunk += b"\x00"
            return chunk
    return None

def _webp_inject(b, chunk):
    body = b[12:] + chunk                                  # append chunk
    out = b"RIFF" + struct.pack("<I", len(body) + 4) + b"WEBP" + body
    return out

def make_webp_chunk(payload: bytes):
    chunk = b"siML" + struct.pack("<I", len(payload)) + payload
    if len(payload) & 1: chunk += b"\x00"
    return chunk

# ---------------- JPEG ----------------
def _jpeg_segments(b):
    i = 2; out = []
    n = len(b)
    while i + 1 < n:
        if b[i] != 0xFF: i += 1; continue
        marker = b[i+1]
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:  # standalone, no length
            i += 2; continue
        if marker == 0xDA:
            out.append(("SOS", marker, b[i:])); break
        if i + 4 > n: break
        ln = struct.unpack(">H", b[i+2:i+4])[0]
        if ln < 2 or i + 2 + ln > n:        # length must include its own 2 bytes & fit
            break
        out.append(("seg", marker, b[i:i+2+ln])); i += 2 + ln
    return out

def _jpeg_extract(b):
    for kind, marker, raw in _jpeg_segments(b):
        if kind == "seg" and marker == 0xEB and SIML_UUID in raw:   # APP11 w/ SIML uuid
            return raw
    return None

def _jpeg_inject(b, seg):
    out = bytearray(b[:2])                                  # SOI
    inserted = False
    for kind, marker, raw in _jpeg_segments(b):
        if not inserted and kind == "seg":                 # after first segment (APP0/APP1)
            out += raw; out += seg; inserted = True
        else:
            out += raw
    if not inserted: out = bytearray(b[:2]) + seg + b[2:]
    return bytes(out)

def make_jpeg_app11(payload: bytes):
    data = SIML_UUID + payload                             # APP11 carries uuid + payload
    length = len(data) + 2
    return b"\xff\xeb" + struct.pack(">H", length) + data

# ---------------- public API ----------------
def has_layer(b: bytes) -> bool:
    return extract_box(b) is not None

def extract_box(b: bytes):
    f = detect_format(b)
    return {"png": _png_extract, "jpeg": _jpeg_extract, "webp": _webp_extract}[f](b)

def inject_box(b: bytes, box: bytes) -> bytes:
    f = detect_format(b)
    return {"png": _png_inject, "jpeg": _jpeg_inject, "webp": _webp_inject}[f](b, box)

def preserve(source: bytes, output: bytes) -> bytes:
    """Copy the SIML layer from source to output. Cross-format aware: extracts
    from source's format, re-wraps into output's format."""
    box_payload = _read_payload(source)
    if box_payload is None:
        return output                                       # nothing to preserve
    f = detect_format(output)
    chunk = {"png": make_png_chunk, "webp": make_webp_chunk, "jpeg": make_jpeg_app11}[f](box_payload)
    if len(box_payload) > MAX_PAYLOAD:                        # belt-and-suspenders
        return output
    if has_layer(output):                                    # avoid duplicate
        return output
    return inject_box(output, chunk)

def _read_payload(b: bytes):
    """Get the raw SIML payload bytes regardless of carrier format. Enforces cap."""
    f = detect_format(b)
    data = None
    if f == "png":
        for typ, d, crc in _png_chunks(b):
            if typ == b"siMl": data = d; break
    elif f == "webp":
        for fourcc, d in _webp_chunks(b):
            if fourcc == b"siML": data = d; break
    elif f == "jpeg":
        box = _jpeg_extract(b)
        if box: data = box[4 + len(SIML_UUID):]
    if data is not None and len(data) > MAX_PAYLOAD:
        return None                        # reject oversized payload (bomb guard)
    return data


# ============================ TESTS ============================
if __name__ == "__main__":
    import io
    from PIL import Image
    import numpy as np

    PAYLOAD = b'{"siml":"0.3","textLayer":[{"id":"t1","text":"+91 98765 43210","type":"phone"}]}'

    def base_image(fmt):
        arr = (np.random.default_rng(1).integers(0, 255, (64, 96, 3))).astype(np.uint8)
        im = Image.fromarray(arr)
        b = io.BytesIO(); im.save(b, fmt.upper() if fmt != "jpeg" else "JPEG"); return b.getvalue()

    def reencode(b, fmt):
        im = Image.open(io.BytesIO(b)).convert("RGB")
        out = io.BytesIO(); im.save(out, fmt.upper() if fmt != "jpeg" else "JPEG", quality=60); return out.getvalue()

    print("SIML PRESERVE - round-trip tests")
    print(f"{'case':34s} {'has@src':>7s} {'survived reencode':>18s} {'payload ok':>11s}")
    print("-"*74)

    embedders = {"png": make_png_chunk, "webp": make_webp_chunk, "jpeg": make_jpeg_app11}
    for fmt in ["png", "webp", "jpeg"]:
        # 1. author: base image + SIML box
        src = inject_box(base_image(fmt), embedders[fmt](PAYLOAD))
        has_src = has_layer(src)
        # 2. platform re-encodes (same format) -> layer destroyed
        reenc = reencode(src, fmt)
        destroyed = not has_layer(reenc)
        # 3. Level-P preserve: copy layer onto the re-encoded output
        final = preserve(src, reenc)
        survived = has_layer(final)
        ok = _read_payload(final) == PAYLOAD
        # sanity: the final image still opens as a valid image
        Image.open(io.BytesIO(final)).convert("RGB").load()
        print(f"{fmt+' same-format reencode':34s} {str(has_src):>7s} "
              f"{('YES' if survived else 'NO')+(' (was destroyed)' if destroyed else ''):>18s} {str(ok):>11s}")

    # 4. cross-format: PNG source -> WebP output (platform converted format)
    src_png = inject_box(base_image("png"), make_png_chunk(PAYLOAD))
    out_webp = reencode(src_png, "webp")
    final = preserve(src_png, out_webp)
    print(f"{'PNG src -> WebP output (convert)':34s} {str(has_layer(src_png)):>7s} "
          f"{('YES' if has_layer(final) else 'NO'):>18s} {str(_read_payload(final)==PAYLOAD):>11s}")

    # 5. resize survives (coords are %, box copies unchanged)
    im = Image.open(io.BytesIO(src_png)).convert("RGB").resize((48, 32))
    rb = io.BytesIO(); im.save(rb, "PNG"); resized = rb.getvalue()
    final = preserve(src_png, resized)
    print(f"{'PNG resized 96->48 wide':34s} {'True':>7s} "
          f"{('YES' if has_layer(final) else 'NO'):>18s} {str(_read_payload(final)==PAYLOAD):>11s}")