# SIML - Selectable Image Markup Language
## Format Specification v0.1 (Draft)

**Status:** Working Draft  
**Authors:** [Your Name]  
**Created:** June 2026  
**License:** Creative Commons CC0 1.0 (Public Domain)

---

## 1. Abstract

SIML is a portable image format that preserves text as selectable, copyable objects
alongside the raster image - without requiring OCR, third-party tools, or
AI inference. It is the image-format equivalent of a PDF's text layer: visually
identical to a normal image, but with real text that supporting applications can
render natively so users can click, drag, and copy - exactly as they would in a
Word document or PDF.

---

## 2. Problem Statement

Every image format today - JPEG, PNG, WebP, AVIF - destroys text information on
export. A designer in Canva types "Call us: +91-98765-43210", positions it on a
banner, and exports to PNG. The phone number is now pixels. Irretrievably.

To extract it, someone must:
- Run OCR (compute-intensive, error-prone, third-party dependent), or
- Use AI vision (even more compute-intensive), or
- Type it manually

SIML solves this at the format level. No inference. No scanning. No extra compute.
The creator's text survives the export - still real, still selectable.

---

## 3. Non-Goals and Patent Distinction

SIML is **not**:

- A system for embedding action triggers or purchase intents in images
  *(distinguished from US8365081, Amazon Technologies - now expired)*
- A scripting or code execution environment
- A replacement for HTML or SVG
- A format requiring internet connectivity to function
- An AI or OCR system

The specific innovation of SIML is the **dual-layer render model**: a raster image
and a co-located text object layer, where supporting renderers draw the text using
their own native text engine at zero opacity - making it transparent to the eye but
real to the selection system. This is architecturally distinct from metadata that
triggers external actions.

---

## 4. File Format

### 4.1 Container

A `.siml` file is a ZIP archive (deflate compression) containing exactly two
required entries and one optional entry:

```
myfile.siml  (ZIP archive)
├── image.jpg      REQUIRED - the raster image (JPEG, WebP, or PNG)
├── meta.json      REQUIRED - SIML metadata and text layer
└── thumb.jpg      OPTIONAL - low-resolution thumbnail for preview
```

The `.siml` extension is registered to this specification. The MIME type is
`image/siml`.

The raster image is a complete, standalone image. Any app that cannot read `.siml`
can be given the inner `image.jpg` directly as a fallback - it renders normally,
just without the text layer.

### 4.2 Magic Bytes

The first four bytes of a valid `.siml` file are the ZIP magic: `50 4B 03 04`.
A SIML-aware parser additionally checks that `meta.json` exists inside the archive
and that its `siml` version field is present.

---

## 5. The meta.json Schema

```json
{
  "siml": "0.1",
  "created": "2026-06-24T00:00:00Z",
  "image": {
    "file": "image.jpg",
    "width": 1080,
    "height": 1080,
    "mime": "image/jpeg"
  },
  "permissions": {
    "platformCanDisableSelection": true,
    "platformCanDisableLinks": true,
    "platformCanDisableAll": false
  },
  "textLayer": [
    {
      "id": "t1",
      "text": "+91-98765-43210",
      "type": "phone",
      "bounds": {
        "x": 5.2,
        "y": 12.4,
        "w": 38.0,
        "h": 7.2
      },
      "style": {
        "font": "Inter",
        "size": 14,
        "weight": "bold",
        "color": "#FFFFFF",
        "align": "left"
      },
      "selectable": true,
      "label": "Call Agent"
    },
    {
      "id": "t2",
      "text": "Plot 4B, Koregaon Park, Pune 411001",
      "type": "address",
      "bounds": {
        "x": 5.2,
        "y": 22.0,
        "w": 60.0,
        "h": 6.0
      },
      "style": {
        "font": "Inter",
        "size": 12,
        "weight": "regular",
        "color": "#FFFFFF",
        "align": "left"
      },
      "selectable": true,
      "label": null
    }
  ]
}
```

---

## 6. Field Reference

### 6.1 Root Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `siml` | string | YES | Spec version. Must be `"0.1"`. |
| `created` | ISO 8601 | NO | Timestamp of file creation. |
| `image` | object | YES | Describes the raster image entry. |
| `permissions` | object | YES | Creator-defined platform permissions. |
| `textLayer` | array | YES | Array of text objects. May be empty `[]`. |

### 6.2 image Object

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | string | YES | Filename of raster entry inside the ZIP. |
| `width` | integer | YES | Image width in pixels. |
| `height` | integer | YES | Image height in pixels. |
| `mime` | string | YES | MIME type: `image/jpeg`, `image/png`, or `image/webp`. |

### 6.3 permissions Object

The creator defines what platforms are allowed to override.

| Field | Type | Default | Description |
|---|---|---|---|
| `platformCanDisableSelection` | boolean | `true` | Platform may disable text selection (force copy-button-only mode). |
| `platformCanDisableLinks` | boolean | `true` | Platform may disable `url` and `phone` dial interactions. |
| `platformCanDisableAll` | boolean | `true` | Platform may treat image as a plain raster fallback. |

If a creator sets `platformCanDisableAll: false`, the platform MUST render the
text layer. This is an assertion by the creator that interaction is essential
content - not decoration.

### 6.4 Text Object Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | YES | Unique ID within this file. |
| `text` | string | YES | The actual text content. Plain UTF-8. |
| `type` | enum | YES | Semantic type. See §6.5. |
| `bounds` | object | YES | Position as percentage of image dimensions. |
| `bounds.x` | float | YES | Left edge. 0–100 (% of image width). |
| `bounds.y` | float | YES | Top edge. 0–100 (% of image height). |
| `bounds.w` | float | YES | Width. 0–100 (% of image width). |
| `bounds.h` | float | YES | Height. 0–100 (% of image height). |
| `style` | object | NO | Visual hints for renderers. Non-normative. |
| `style.font` | string | NO | Font family name. Informational only. |
| `style.size` | float | NO | Font size in points at base image size. |
| `style.weight` | string | NO | `"regular"`, `"medium"`, `"bold"`. |
| `style.color` | string | NO | Hex color string e.g. `"#FFFFFF"`. |
| `style.align` | string | NO | `"left"`, `"center"`, `"right"`. |
| `selectable` | boolean | YES | Whether this text object participates in selection. |
| `label` | string | NO | Human-readable label shown in copy-button UI. |

### 6.5 Type Enum

| Value | Meaning | Platform behavior suggestion |
|---|---|---|
| `text` | Generic copyable text | Copy to clipboard |
| `phone` | Phone number | Offer to open dialer |
| `email` | Email address | Offer to open mail client |
| `url` | Web URL | Offer to open browser |
| `address` | Physical address | Offer to open maps |

Platforms decide how to act on types. The `type` field is a hint, not a command.

---

## 7. Rendering Contract

### 7.1 The Dual-Layer Model

A SIML-aware renderer MUST:

1. Render the raster image normally (fill the display area).
2. For each text object where `selectable: true`:
   - Create a real text node in the render tree, positioned over the raster
     using `bounds` percentages.
   - Set the text node's visual opacity to **zero** (invisible, but present in
     the accessibility and selection tree).
   - The underlying raster already shows the text visually (baked in by the
     creator tool). The text node is a transparent twin of what the eye sees.
3. Enable the platform's native text selection engine on these nodes.

The user sees the raster. The cursor hits the text node. Selection works.
No custom selection code required - the browser, OS, or app handles it natively.

### 7.2 Platform Modes

Based on the `permissions` object, a platform may choose one of four modes:

| Mode | Description |
|---|---|
| **Full** | Transparent text layer rendered. Native click-drag selection. |
| **Button-only** | Text layer rendered at opacity 0 but `user-select: none`. A copy button or three-dot menu surfaces the text values instead. |
| **Raster-only** | Text layer ignored. Image renders as a plain raster. |
| **Blocked** | Text layer ignored AND no copy button. Image is fully locked. |

Platforms MUST respect `platformCanDisableAll: false` by not using Raster-only or
Blocked mode.

### 7.3 Accessibility

Text objects with `selectable: true` MUST be exposed to screen readers via the
platform's accessibility tree with their `text` value and `type`. This is
non-optional regardless of visual mode.

---

## 8. The Fallback Guarantee

This is the most important design principle of SIML:

> A `.siml` file opened in any app that does not understand SIML **must not break**.

The inner raster image is a complete, standalone image. Platforms or apps that
don't recognise the `.siml` extension can:
- Rename to `.zip`, extract `image.jpg`, and display it normally.
- Or simply tell the user: "This is a SIML file - download a viewer."

The text layer is additive. It adds capability. It never removes compatibility.

---

## 9. Authoring

An authoring tool (Canva plugin, Figma plugin, standalone web app) that exports
SIML MUST:

1. Take the design's existing text layers (which the tool already tracks as
   objects - font, size, position, color, content).
2. Burn those text layers into the raster export normally (so the image looks
   identical to the design).
3. Simultaneously write each text layer as a text object in `meta.json`,
   translating the tool's coordinate system to percentage-based bounds.
4. Package both into a `.siml` ZIP.

Step 3 is what no existing export pipeline does. That gap is the product.

---

## 10. Versioning

The `siml` field in `meta.json` is the spec version. Future versions increment
the minor number (e.g., `"0.2"`) for backward-compatible additions, and the
major number (e.g., `"1.0"`) for breaking changes.

A renderer that encounters a major version it does not support MUST fall back to
rendering the raster only. It MUST NOT attempt to parse an unknown major version's
text layer.

---

## 11. What This Spec Does Not Define

Intentionally out of scope for v0.1:

- Code execution or scripting within `.siml` files
- Purchase or commerce actions (see §3 - Patent Distinction)
- DRM or encryption of text content
- Animated or video raster layers
- Server-side metadata injection at serve-time
- Multi-page or multi-image containers

These may be addressed in future versions.

---

## 12. Reference Implementation (Planned)

| Component | Description | Status |
|---|---|---|
| `siml-writer` | Node.js CLI and web API to create `.siml` files | Planned |
| `siml-reader` | Browser JS library (`<5KB`) to render `.siml` | Planned |
| `siml-canva` | Canva export plugin | Planned |
| `siml-figma` | Figma export plugin | Planned |
| `siml.io` | Web-based authoring tool | Planned |

---

## 13. License

This specification is released into the public domain under CC0 1.0.
Anyone may implement, extend, or build products on SIML without royalties or
permission. Attribution is appreciated but not required.

The name "SIML" and the logo (when created) may be trademark-protected separately
to ensure quality and prevent misuse of the format name.

---

*End of SIML Specification v0.1*
