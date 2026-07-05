# SIML Export - Photoshop plugin (UXP)

Exports the active Photoshop document as a PNG or JPEG whose text stays
selectable, copyable, and machine-readable: every visible type layer rides in
the JUMBF container (T0) with exact strings and pixel-accurate bounds, the
first phone number found rides in the invisible dual-band watermark (T1), and
the image's fingerprint is registered for screenshot-grade recovery (T2).

Unlike the Canva app, UXP has real file access: the export lands through a
native save dialog - no stash server, no external-URL flow.

## Load it (development mode)

1. Install the **UXP Developer Tool** (Creative Cloud app → search "UXP
   Developer Tool", or developer.adobe.com/photoshop/uxp/devtool/).
2. Photoshop 24.4+ must be running.
3. In UXP Developer Tool: **Add Plugin** → pick
   `packages/siml-photoshop/manifest.json` → **Load**.
4. In Photoshop: Plugins → SIML Export opens the panel.

## Using it

1. Open any document with type layers (a promo banner with a phone number is
   the ideal demo).
2. Pick a format, choose tiers, press **Export with SIML**.
3. A save dialog appears; the file is written locally, byte-exact.
4. Verify at https://siml-demo.vercel.app/view - drop the file, run the
   strip-and-recompress simulator, watch the text recover.

The T2 registry defaults to the deployed demo; the manifest's network
permission already allows that domain. If the registry is unreachable the
export continues with T0 + T1.

## How it works (differences from the browser hosts)

- Pixels come from `imaging.getPixels` on a flattened duplicate resized to the
  canonical 1024-wide grid; the watermarked pixels go back via `putPixels`
  before `saveAs` - no canvas anywhere.
- The perceptual hashes use a pure-JS progressive box resampler that mirrors
  the browser canvas pipeline; hashes land within the T2 match threshold of
  the other implementations.
- Text comes from `layer.textItem.contents` with `layer.bounds` geometry -
  exact strings, exact boxes, straight from the document.
- Document edits run inside `core.executeAsModal`, on a duplicate that is
  closed without saving: your working document is never touched.

## Illustrator status (checked 2026-07)

UXP is not yet public for third-party Illustrator plugins; the supported
panel technology there is CEP. The Illustrator extension lives at
`packages/siml-illustrator` and shares this plugin's engine byte-for-byte.
