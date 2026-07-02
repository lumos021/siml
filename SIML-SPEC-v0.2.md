# SIML - Selectable Image Markup Language
## Format Specification v0.2 (Draft)

**Status:** Working Draft
**Created:** June 2026
**Supersedes:** v0.1
**License:** Creative Commons CC0 1.0 (Public Domain)

---

## 0. What Changed Since v0.1

v0.1 invented four bespoke carrier embeddings and a native binary container. A
prior-art review showed the embedding mechanism was already a solved, shipping
problem (C2PA / Content Credentials uses the exact same APP-marker, PNG ancillary
chunk, and WebP RIFF-chunk slots), the positioned-text-region idea was already a
standard (IPTC Image Regions, 2019), and the invisible co-located selectable
text layer was the decades-old PDF "sandwich." v0.2 stops reinventing the
transport and concentrates the spec on the parts that are actually new: the
**render contract**, the **semantic interaction model**, and the **authoring
pipeline**.

Concretely:

- **Carrier replaced.** The payload now travels inside a **JUMBF box**
  (ISO/IEC 19566-5) - the same container family C2PA uses - instead of four
  hand-rolled embeddings.
- **Two envelope tiers.** Default is an *unsigned* JUMBF box (low friction).
  Optional upgrade is a *signed* C2PA assertion (`org.siml.textLayer.vN`) for
  tamper-evidence and provenance.
- **Identity pinned.** The SIML JUMBF box now has a fixed v4 UUID
  (`de6062e1-9e7b-494e-94b3-db6fcc257fdc`) with a registration-upgrade path (§4.1.1),
  so files written today stay valid forever.
- **Encoding is now standards-defined.** Raw UTF-8 JSON in a JUMBF JSON box
  (baseline), with optional JUMBF brotli compression - v0.1's hardcoded zlib is
  gone (§4.1.2).
- **Coordinate frame & text fidelity pinned** (§5.3): bounds are in *displayed*
  (EXIF-orientation-applied) space; copy is byte-for-byte with no normalization.
- **Forward-compatibility rules written** (§14): ignore-unknown-fields, enum
  degradation, append-only required fields - the rules that let the format grow
  without breaking old files.
- **Tier 2 kept in scope** (not deferred) with versioned assertion labels.
- **Format D (binary `.siml`) deleted.** A container that needs a special viewer
  or shows nothing contradicted the portability goal. A "clean file" is just a
  normal JPEG/WebP/PNG carrying a JUMBF box.
- **Bespoke chunk-walking, CRC32, and magic-byte detection deleted** in favor of
  JUMBF box scanning via existing parsers.
- **`bounds` upgraded** to support per-line (and optional per-word) runs, curing
  the "words run together" selection failure of single-box overlays.
- **Style object expanded** and a dedicated **Style & Font Handling** contract
  (§6) added - when style is geometric vs. when it is visual.
- **Anti-cloaking + integrity contract added** (§9), now mandatory.
- **Accessibility designed, not asserted** (§10).

---

## 1. Abstract

SIML preserves text as selectable, copyable objects inside ordinary image files  - 
without OCR, AI inference, or a new file extension. It is the image equivalent of
a PDF text layer: the image looks identical to a normal raster, but a co-located
text layer lets supporting renderers expose real text the user can select, copy,
and act on.

SIML is a **text-layer payload** carried inside a standard **JUMBF box** that
rides in the native metadata slot of PNG, JPEG, and WebP. JUMBF-unaware readers
skip the box and display a normal image. JUMBF-aware readers (including the
existing C2PA tooling ecosystem) can locate and read it.

---

## 2. Problem Statement

Every raster export destroys text. A designer types a phone number on a banner,
exports to WebP, and the number becomes pixels. Recovering it later requires OCR,
AI vision, or retyping - all unnecessary compute for data that existed at export
time. SIML captures that text at the moment of export and carries it with the
image, in a container that already has cross-industry tooling.

---

## 3. Relationship to Prior Art (and Non-Goals)

SIML deliberately reuses existing standards rather than competing with them.

| Existing work | What it provides | What SIML adds |
|---|---|---|
| **C2PA / Content Credentials** | The carrier mechanics (JUMBF in APP11 / PNG chunk / WebP chunk), skip-unknown fallback, signing | A non-provenance payload + an interaction/render contract; an *unsigned* default tier |
| **JUMBF (ISO/IEC 19566-5)** | The box container, UUID labelling, skip-unknown guarantee | A pinned SIML box UUID + JSON payload schema |
| **IPTC Image Regions** | Positioned regions with attached metadata, embedded via XMP | Copyable, semantically-typed text with platform behaviors; a selection render model |
| **PDF text "sandwich"** | Invisible co-located selectable text over a raster | The same idea for *web raster images*, with permissions and typed actions |

**SIML is NOT:** an action/commerce trigger system; a scripting or code-execution
environment; a replacement for HTML/SVG/PDF; an OCR or AI system; a format that
requires connectivity to function; a provenance or authenticity system (that is
C2PA's job - SIML can ride alongside it).

The specific innovation is the **dual-layer render contract**: raster pixels and
co-located, semantically-typed text objects in one file, where supporting
renderers expose the text to the native selection and accessibility systems.

---

## 4. Carrier Model

### 4.1 The JUMBF Payload Container

The SIML payload (§5) is stored inside a JUMBF superbox. The superbox holds a
standard JUMBF **content-type box** carrying the payload bytes, so the data type
is self-describing to any JUMBF reader - no out-of-band knowledge of the encoding
is required.

```
SIML JUMBF superbox
├── Description Box
│     UUID:        de6062e1-9e7b-494e-94b3-db6fcc257fdc   (the SIML box UUID - PINNED, see §4.1.1)
│     Label:       "siml"
│     Requestable: true                                    (addressable by JUMBF URI, for Tier 2/3)
└── Content box (one of):
      • JSON content-type box   → raw UTF-8 JSON            (baseline, MUST be supported)
      • Compressed box ("brob")  → brotli-compressed JSON    (optional, for large payloads)
```

Per JUMBF semantics, a reader that does not recognize the superbox UUID **MUST
skip and ignore it**. This is the fallback guarantee (§11), inherited - not
hand-built.

> Implementation note: reuse an existing JUMBF reader/writer (e.g. the one inside
> the `c2pa-rs` / `c2pa-js` toolchain) rather than parsing boxes by hand. The
> same toolchain already implements the JSON content-type box and the brotli
> compressed-box wrapper.

#### 4.1.1 Box Identity (Pinned - Do Not Change)

The SIML superbox is identified by a **version-4 (random) UUID**, pinned for the
life of the format:

```
de6062e1-9e7b-494e-94b3-db6fcc257fdc
bytes: DE 60 62 E1 9E 7B 49 4E 94 B3 DB 6F CC 25 7F DC
```

A random UUID is used deliberately. SIML is an independent, unregistered spec; a
random UUID is collision-proof against every current and future registered
JUMBF/C2PA box type, whereas a structured "fourcc-style" UUID (as C2PA uses for
its registered `c2pa` box) could collide with a later formal registration.

**Readers MUST match on this UUID.** The `"siml"` label is a secondary, human-
readable hint only; never key behavior on the label alone.

**Registration-upgrade path.** If SIML is ever formally registered with a
standards body and assigned an official box UUID, that UUID will be added as an
*additional* recognized identity in a future minor version. Readers from that
version forward MUST accept **both** the pinned random UUID above and the
registered one, so files written today remain valid forever. The pinned UUID is
never retired.

#### 4.1.2 Payload Encoding

- **Baseline (MUST):** the payload is raw UTF-8 JSON in a JUMBF JSON content-type
  box. Self-describing, maximally interoperable, and for typical layers (a handful
  of text objects) the size cost over compression is negligible.
- **Compressed (MAY):** for large payloads, the JSON may instead be carried in a
  JUMBF brotli compressed-box ("brob"). Compression is thus a **standards-defined
  wrapper**, not an out-of-band convention - there is no SIML-specific compression
  format to negotiate. (v0.1's hardcoded zlib/pako is removed.)
- **Bomb protection (MUST):** a reader MUST cap the decompressed payload size
  (recommended limit: 4 MiB) and abort to raster-only fallback if exceeded, to
  prevent decompression-bomb abuse.

### 4.2 Tier 1 - Unsigned JUMBF Box (Default)

The default tier embeds the SIML JUMBF box with **no signature**. Low friction,
no signing identity required. Per-carrier placement reuses the conventions C2PA
established:

**JPEG** - the JUMBF box is carried in **APP11** marker segments (`0xFF 0xEB`).
Because each APP marker payload is capped near 64 KB, a large box is split across
multiple APP11 segments per the standard packet-sequence wrapping.

> Edge case to inherit from libraries, not re-solve: a JUMBF payload whose length
> is an exact multiple of the segment size can overflow the APP11 length field.
> Use a maintained writer.

**PNG** - the JUMBF bytes are carried in an ancillary, private, safe-to-copy
chunk named **`siMl`**:

```
s  i  M  l
│  │  │  └─ lowercase = safe-to-copy (compliant editors copy it on re-encode)
│  │  └──── uppercase = reserved (required uppercase)
│  └──────── lowercase = private
└────────── lowercase = ancillary (unknown readers skip safely)
```

Placed immediately before `IEND`. (This is the same case-bit reasoning C2PA uses
for its `caBX` chunk; `siMl` is the SIML-specific equivalent.)

**WebP** - the JUMBF bytes are carried in a RIFF chunk with FourCC **`siML`**,
placed last among the chunks. Simple (VP8/VP8L) files are first converted to
Extended (VP8X). The RIFF file-size field is updated; odd-length payloads are
padded to even length.

### 4.3 Tier 2 - Signed C2PA Assertion (In Scope, Opt-In)

Tier 2 is **part of v0.2**, not deferred - the carrier is identical, so supporting
it later would have meant a second format-identity decision, which is exactly the
kind of permanent fork future-proofing avoids. It is opt-in at authoring time;
nothing in the default (Tier 1) experience depends on it.

When a creator also wants tamper-evidence or provenance, the **same JSON payload**
is wrapped as a custom C2PA assertion labelled **`org.siml.textLayer.v2`** inside
a signed C2PA manifest, inheriting C2PA's signing, trust list, and edit-history
machinery at the cost of requiring a signing identity.

**Assertion label versioning.** C2PA assertion labels carry a `.vN` suffix; the
SIML major version maps to that suffix (`…​.v2` for spec major 0/2-era, `…​.v3`
for the next breaking revision, etc.). Readers MUST accept any `org.siml.textLayer`
assertion whose suffix is ≤ their supported major and parse the inner payload by
its own `siml` version field (§14). This lets a single image legitimately carry
more than one labelled version during a migration without ambiguity.

A reader resolves the payload from **whichever tier is present**: check for a SIML
C2PA assertion first; otherwise scan for a bare SIML JUMBF box (matched by the
pinned UUID, §4.1.1).

### 4.4 Format Detection (Reader Side)

```
1. Parse the file's metadata boxes with a JUMBF-aware reader.
2. If a C2PA manifest contains an `org.siml.textLayer.vN` assertion → use it (Tier 2).
3. Else if a JUMBF box whose UUID == de6062e1-9e7b-494e-94b3-db6fcc257fdc
   exists → use it (Tier 1).      (Match on UUID, not the "siml" label.)
4. Else → no SIML data. Render as a plain image. No error, no crash.
```

No bespoke magic-byte routine. No `.siml` extension.

### 4.5 Removed in v0.2

The native binary `.siml` container (v0.1 Format D), its `RAST/TXTL/PERM/META/
THMB/SEND` chunk table, the second CRC-32 implementation, the `image/siml` MIME
type, and the `.siml` extension are **removed**. A standalone SIML file is simply
a normal PNG/JPEG/WebP carrying a SIML JUMBF box.

---

## 5. Text Layer Schema (v0.2)

```json
{
  "siml": "0.2",
  "image": { "width": 1600, "height": 900 },
  "permissions": {
    "platformCanDisableSelection": true,
    "platformCanDisableLinks": true,
    "platformCanDisableAll": false
  },
  "textLayer": [
    {
      "id": "t1",
      "text": "+91 98765 43210",
      "type": "phone",
      "bounds": { "x": 5.2, "y": 12.4, "w": 38.0, "h": 7.2 },
      "runs": [
        { "x": 5.2, "y": 12.4, "w": 38.0, "h": 7.2, "text": "+91 98765 43210" }
      ],
      "style": {
        "font": "Inter",
        "size": 14,
        "weight": "bold",
        "italic": false,
        "color": "#FFFFFF",
        "align": "left",
        "letterSpacing": 0,
        "lineHeight": 18,
        "decoration": "none"
      },
      "selectable": true,
      "label": "Call agent"
    }
  ]
}
```

### 5.1 Field Reference

**Root fields**

| Field | Type | Required | Description |
|---|---|---|---|
| `siml` | string | YES | Spec version. Must be `"0.2"`. |
| `image` | object | NO | Authoring-resolution `width`/`height` in px. Used to interpret point sizes and pixel-based style values. |
| `permissions` | object | YES | Creator-defined platform permissions. |
| `textLayer` | array | YES | Array of text objects. May be empty `[]`. |

**permissions object**

| Field | Type | Default | Description |
|---|---|---|---|
| `platformCanDisableSelection` | boolean | `true` | Platform may disable native text selection. |
| `platformCanDisableLinks` | boolean | `true` | Platform may disable typed interactions (phone/url/etc). |
| `platformCanDisableAll` | boolean | `true` | Platform may ignore the text layer entirely. |

**Text object fields**

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | YES | Unique within this file. |
| `text` | string | YES | Full text content, UTF-8. The canonical copy value. |
| `type` | enum | YES | Semantic type (§5.2). |
| `bounds` | object | YES | Overall bounding box (see §5.3). |
| `runs` | array | NO | Per-line / per-word sub-boxes (see §5.3). Strongly recommended for multi-word text. |
| `style` | object | NO | Visual + metric metadata (§5.4, §6). |
| `selectable` | boolean | YES | Whether this object participates in selection. |
| `label` | string | NO | Human-readable label for copy-button UI. |

### 5.2 Type Enum

| Value | Suggested platform behavior |
|---|---|
| `text` | Copy to clipboard |
| `phone` | Copy + offer to open dialer |
| `email` | Copy + offer to open mail client |
| `url` | Copy + offer to open browser |
| `address` | Copy + offer to open maps |

### 5.3 Bounds and Runs

All coordinates are **percentages of image dimensions** (0–100), origin top-left.
An explicit percentage model avoids the v0.1 pixel/percent guessing bug.

**Reference frame (PINNED).** Percentages are relative to the image **as
displayed** - i.e. *after* any EXIF/container orientation transform is applied,
not the raw stored pixel grid. A JPEG with an EXIF orientation flag presents
rotated/flipped pixels to the viewer; bounds defined against the un-rotated stored
buffer would misalign on every such file. Authors MUST emit bounds in displayed
orientation; readers MUST apply orientation to the raster before positioning
overlays. This convention is fixed for the life of the format because changing it
later would silently break previously written files.

**Precision.** Coordinates are stored to at most **4 decimal places**. This is
plenty at any realistic resolution and keeps payloads diff-stable.

- `bounds` is the overall rectangle of the text object. Required.
  Constraints: `x+w ≤ 100`, `y+h ≤ 100`, `w>0`, `h>0`.
- `runs` is an ordered array of sub-rectangles, each with its own `text`,
  covering one visual **line** (minimum) or one **word** (preferred for precise
  selection). Each run obeys the same coordinate constraints.

**Why runs matter.** A single bounding box forces the renderer to lay all text
inside one rectangle, which is exactly what makes invisible-text selection "run
several words together" (a known failure in PDF sandbox renderers). Per-line or
per-word runs let the selection highlight track the visible glyphs. When `runs`
is absent, the renderer falls back to a single box and selection is approximate.

**Text fidelity (PINNED).** `text` is stored UTF-8, exactly as authored. Readers
copy it **byte-for-byte** and apply **no** Unicode normalization, case folding, or
whitespace trimming, so the copy result is deterministic across platforms. The
concatenation of run `text` values SHOULD equal the object `text`; if they
disagree, the object `text` is canonical for copy and `runs` are used only for
geometry.

### 5.4 Style Object

| Field | Type | Used for | Description |
|---|---|---|---|
| `font` | string | metric hint, reflow | Font family. See §6 on availability. |
| `size` | float | metric hint, reflow | Point size at full image resolution. |
| `weight` | enum | metric hint, reflow | `regular`, `medium`, `semibold`, `bold`. |
| `italic` | boolean | metric hint, reflow | Italic/oblique. Affects glyph advance. |
| `color` | string | **reflow only** | `#RRGGBB`. Ignored in transparent selection mode. |
| `align` | enum | metric hint, reflow | `left`, `center`, `right`. |
| `letterSpacing` | float | **alignment**, reflow | Tracking in px at full resolution. Alignment-critical. |
| `lineHeight` | float | alignment, reflow | Line box height in px at full resolution. |
| `decoration` | enum | reflow | `none`, `underline`. |

See §6 for exactly when each field is geometric vs. visual.

---

## 6. Style & Font Handling

This section answers the practical question: *if we render text over the image,
do we need to preserve the font, color, and size?* The answer depends on the mode.

### 6.1 What the Raster Owns vs. What the Overlay Owns

In the default **transparent-selection** mode, the **raster already shows the
fully styled text** - font, color, size, and weight are baked into the pixels.
The overlay text nodes are `color: transparent`. Therefore:

- **Color is irrelevant** to selection mode. The overlay is invisible; the
  styled glyphs the user sees come from the raster. `style.color` is stored only
  for the reflow mode (§6.4) and for round-tripping back into an editor.
- **Font, size, weight, italic, and letterSpacing are *geometric* inputs**, not
  visual ones. Their only job in selection mode is to make the transparent text
  occupy the **same space** as the baked glyphs, so the selection highlight and
  cursor hit-testing line up with what the eye sees.

So "preserve the styling" in selection mode means **preserve the geometry**, not
reproduce the appearance.

### 6.2 Geometric Alignment Is the Priority

The hard problem is font availability. If the design used a font the viewer does
not have installed, the browser substitutes a fallback with different metrics, and
the transparent text drifts out from under the baked glyphs - selection
misaligns. Storing more style fields does not fix this on its own.

Two mechanisms, used together, keep alignment robust:

1. **Per-run geometry (§5.3).** Anchor each line/word to its recorded box.
2. **Box-fit scaling.** Within each run, after laying out the transparent text,
   scale it to the recorded box so its rendered width matches regardless of the
   substituted font.

**Box-fit technique (renderer):**

```
For each run:
  1. Position a transparent text node at the run's (x,y), width w, height h.
  2. Set font-size from style.size (scaled to current rendered image height)
     or, if absent, from the run height h.
  3. Measure the node's natural rendered width (e.g. range/getBoundingClientRect).
  4. scaleX = runWidthPx / naturalWidthPx
  5. Apply transform: scaleX(scaleX) with transform-origin: left.
     (Or distribute the delta via letter-spacing for cleaner caret behavior.)
```

This makes selection track the visible characters even when the original font is
unavailable - the same principle PDF viewers use when they scale glyph advances
to recorded widths.

### 6.3 Font Loading (Optional Enhancement)

A renderer **MAY** attempt to load a matching web/system font named in
`style.font` to improve metric accuracy before box-fitting, but **MUST NOT** fail,
block, or visibly change the raster if the font is missing. Font loading is a
nice-to-have on top of box-fit, never a dependency.

### 6.4 Reflow / High-Contrast Mode (Optional)

A renderer MAY offer a mode that **draws live, visible text instead of showing
the raster** - for accessibility (high contrast, user font size), reflow on small
screens, or text-only export. **In this mode all style fields are visual and
fidelity matters: `color`, `font`, `weight`, `italic`, `decoration`, `align`,
`size`, `lineHeight` are all honored.** Because the original font may be
unavailable, reflow output is explicitly "best effort, not pixel-identical to the
raster," and the renderer SHOULD signal that it is showing reconstructed text.

If high-fidelity reflow is required, a future optional `FONT` resource (an
embedded or referenced web font subset) may be defined - out of scope for v0.2,
and subject to font-license constraints, which authors are responsible for.

### 6.5 Summary Table

| Style field | Transparent selection mode | Reflow / visible mode |
|---|---|---|
| `color` | ignored (raster shows it) | honored |
| `font` | metric hint for alignment | honored (best effort) |
| `size` | geometric (font-size for box-fit) | honored |
| `weight` / `italic` | affects glyph advance → geometry | honored |
| `letterSpacing` | alignment-critical | honored |
| `lineHeight` | multi-line geometry | honored |
| `align` | run placement hint | honored |
| `decoration` | ignored | honored |

---

## 7. Rendering Contract

### 7.1 The Dual-Layer Model

A SIML-aware renderer MUST:

1. Render the raster image normally and unmodified.
2. For each text object with `selectable: true`, for each run (or the single
   `bounds` if `runs` is absent):
   - Create a real text node positioned with the run's percentage coordinates.
   - Set its visual `color: transparent`.
   - Apply box-fit (§6.2) so its extent matches the baked glyphs.
3. Enable the platform's native selection engine on these nodes.

The user sees the raster; the cursor hits the transparent text; native selection
and copy work without custom selection code.

### 7.2 Integrity Rules (Renderer)

- The raster MUST be presented in **displayed orientation** (EXIF/container
  orientation applied) before any overlay is positioned, since bounds are defined
  in that frame (§5.3).
- Span `textContent` MUST equal the object/run `text` byte-for-byte. Never
  `innerHTML`.
- A corrupt, missing, oversized (§4.1.2), or unknown-major-version payload MUST
  fall back to plain raster with no crash.
- Unknown fields and enum values MUST be handled per §14 (ignore / degrade), never
  by discarding the whole layer.
- `bounds`/`runs` violating the coordinate constraints are clamped, or the
  offending object is dropped; never overflow the image box.
- Never execute anything found in a payload.

---

## 8. Platform Modes

| Mode | Description |
|---|---|
| `full` | Transparent text layer; native click-drag selection. |
| `button_only` | Text layer present but `user-select: none`; copy buttons surface values. |
| `reflow` | Visible reconstructed text (see §6.4). |
| `raster_only` | Text layer ignored; plain raster. |
| `blocked` | Text layer ignored; no copy affordance. |

Platforms MUST respect `platformCanDisableAll: false` - `raster_only` and
`blocked` are not permitted when that flag is false.

**Mobile note:** `button_only` is the recommended default on touch devices, where
drag-selecting text inside an image is awkward. It also sidesteps box-fit
alignment entirely, since the copy value comes straight from `text`.

---

## 9. Anti-Cloaking and Integrity

A selectable text layer that can differ from the visible pixels is, by
construction, a cloaking primitive (the visible URL could say one thing and the
copyable/openable `url` say another). Because SIML rides in the same container
family as provenance tooling, this must be handled explicitly.

- Authored rendered text **SHOULD** match the raster it sits over.
- Before acting on a `url`, `phone`, `email`, or `address` (dialing, opening,
  navigating), a renderer **MUST** surface the literal target to the user rather
  than acting silently.
- Renderers **SHOULD** provide a way to reveal the raw `text` of any object
  (e.g. on hover/long-press) so a divergence between seen and stored is visible.
- Renderers **MUST NOT** auto-execute typed actions without user intent.

---

## 10. Accessibility (Designed)

Concrete DOM contract, to be verified on a real screen reader, not assumed:

- The raster `<img>` carries an **empty `alt`** (`alt=""`) when a SIML text layer
  is present, so the layer - not a redundant alt - is the accessible text source.
- Each selectable run/object span carries `role="text"` and `aria-label` equal to
  its `text`.
- Objects are exposed in document order matching their visual reading order
  (sort by `bounds.y`, then `bounds.x`) so screen-reader traversal is sensible.
- Typed objects expose their `type` (e.g. as an accessible description) so a
  phone number is announced as such.
- Accessibility exposure is independent of visual mode: even in `button_only`,
  the text is reachable by assistive tech.

---

## 11. Fallback Guarantee

> A SIML-enhanced image opened in any app that does not understand SIML MUST
> display as a normal image and MUST NOT error, corrupt, or warn.

This is now **inherited from JUMBF**: a reader encountering a box whose UUID it
does not recognize skips it. PNG `siMl` is ancillary + safe-to-copy; JPEG APP11
and unknown WebP FourCC chunks are skipped by conformant readers. The text layer
is purely additive.

---

## 12. Resilience Tiers

**Tier 1 - In-file box (default).** The payload rides inside the image. Survives
CDN delivery, email attachments, direct sharing, and any pipeline that does not
decode-and-re-encode pixels.

**Tier 2 - Platform cooperation (opt-in).** A SIML-aware platform reads the box
before recompressing and re-embeds it after. Trivial read-one / write-one
overhead.

**Honest limit:** any pipeline that re-encodes pixels (Instagram, WhatsApp,
X/Twitter, many CMS optimizers, an HTML-canvas `toBlob`) strips *all* embedded
metadata - C2PA, EXIF, XMP, and SIML alike. No image format prevents this. On
those surfaces only Tier 2 cooperation, or a future registry anchor, can carry
SIML.

**Tier 3 - Registry anchor (future spec).** A perceptual hash retrieves the text
layer from a registry after recompression destroys the box. Deferred; brittle;
introduces a network dependency and is out of scope for v0.2.

---

## 13. Authoring Pipeline

A SIML-aware exporter MUST:

1. Take the design's existing text layers (content, font, size, position, color,
   per-line layout - data the tool already has).
2. Burn them into the raster export exactly as a normal export would (no visual
   change).
3. Simultaneously emit each text layer as a SIML text object, converting the
   tool's coordinates to percentage `bounds` and, wherever the tool knows line
   breaks, emitting per-line `runs`.
4. Embed the payload as a SIML JUMBF box (Tier 1) or `org.siml.textLayer`
   assertion (Tier 2).

Step 3 - emitting structured, positioned text at export - remains the product.
Everything else is now standard tooling.

---

## 14. Versioning and Forward Compatibility

The `siml` field is the spec version (`major.minor`). These rules are what let
the format grow for years without orphaning files written today:

- **Unknown fields MUST be ignored.** A reader encountering object, style, run,
  or root fields it does not know MUST skip them and process the rest. This is the
  single most important rule: it means future minor versions can *add* fields
  (new style attributes, new metadata) and old readers keep working.
- **Unknown enum values degrade, don't fail.** An unrecognized `type` MUST be
  treated as `text` (copyable, no special action). An unrecognized `mode` or
  `weight` falls back to its nearest known default. Never drop an object solely
  because an enum grew.
- **Unknown minor version → proceed.** Same major, higher minor: parse what you
  understand, ignore the rest.
- **Unknown major version → raster only.** A breaking revision is opt-in for new
  readers; old readers safely show the plain image.
- **Required fields are append-only across minors.** No minor version may add a
  new *required* field or tighten an existing constraint; such changes are
  reserved for a major bump. This guarantees a v0.x writer's output stays valid
  for every future v0.y reader.

Together with the pinned box UUID (§4.1.1), pinned coordinate frame and text
fidelity (§5.3), and the registration-upgrade path, these rules mean: **anything
added later is additive, and anything breaking is gated behind a major version a
reader must explicitly adopt.**

---

## 15. Out of Scope for v0.2 (Reserved for Additive Growth)

The following are deliberately deferred. Because of the forward-compatibility
rules (§14), each can be added in a later **minor** version as optional fields
without breaking any v0.2 file or reader:

- Multi-language / alternate text per object (e.g. an optional `altLang` map) for
  i18n - reserved; do not repurpose `text`.
- Embedded-font (`FONT`) resource for high-fidelity reflow (license-bound).
- Richer `decoration` / inline styling for reflow mode.
- A registered (standards-body) box UUID alongside the pinned one (§4.1.1).

Reserved for a future **major** version (breaking), out of scope here:

- Code execution inside images - permanently excluded, not merely deferred.
- Commerce / purchase triggers - permanently excluded.
- DRM or encryption of text content.
- Animated or video raster layers.
- Multi-page containers.
- Tier 3 registry / perceptual-hash anchor protocol.

To keep the namespace clean for these, **reserved field names** (`altLang`,
`font` as a resource ref, `page`, `frame`, `registry`) MUST NOT be used for other
purposes by implementations.

---

## 16. Reference Implementation (Planned)

| Component | Description |
|---|---|
| `siml-core` | Schema + validation + JUMBF box read/write (wraps an existing JUMBF lib; JSON box baseline, brotli "brob" optional) |
| `siml-writer` | Node CLI + API: embeds SIML JUMBF into PNG/JPEG/WebP; optional C2PA-assertion mode |
| `siml-reader` | Browser library: detects SIML by pinned UUID, applies orientation, renders dual-layer with box-fit selection |
| `siml-demo` | Next.js demo: `/create` annotation tool, `/view` renderer |
| `siml-figma` / `siml-canva` | Export plugins emitting per-line runs |
| `siml-conformance` | Frozen fixture set: known-good files + readers MUST round-trip them. Locks the on-disk contract so future versions can't silently drift. |

Deleted vs. v0.1: `write-siml.js` (binary container), hand-rolled CRC32, the
custom zlib/pako compression contract, and bespoke per-format chunk walkers  - 
replaced by library-backed JUMBF I/O.

---

## 17. License

Released into the public domain under CC0 1.0. Anyone may implement, extend, or
build products on SIML without royalties or permission.

---

*End of SIML Specification v0.2*