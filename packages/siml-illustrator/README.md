# SIML Export - Illustrator extension (CEP)

Exports the active artboard as a PNG or JPEG whose text stays selectable,
copyable, and machine-readable: every visible text frame rides in the JUMBF
container (T0) with exact strings and artboard-relative bounds, the first
phone number found rides in the invisible dual-band watermark (T1), and the
image's fingerprint is registered for screenshot-grade recovery (T2).

Why CEP and not UXP: Adobe has not opened UXP to third-party Illustrator
plugins, and there is no public timeline for it. CEP is the supported panel
technology for Illustrator today (CEP 12 as of Illustrator 29.5.1), so that
is what this ships on. The watermark engine is byte-identical to the
Photoshop plugin's, so a future UXP port is a host-glue rewrite only.

## Install (development mode, Windows)

1. Allow unsigned extensions (one-time). In an elevated-or-normal PowerShell:

   ```powershell
   reg add HKCU\Software\Adobe\CSXS.12 /v PlayerDebugMode /t REG_SZ /d 1 /f
   reg add HKCU\Software\Adobe\CSXS.11 /v PlayerDebugMode /t REG_SZ /d 1 /f
   ```

   (CSXS.12 covers Illustrator 29.5.1+; CSXS.11 covers earlier releases.)

2. Copy this folder into the per-user CEP extensions directory:

   ```powershell
   robocopy packages\siml-illustrator "$env:APPDATA\Adobe\CEP\extensions\siml-illustrator" /E
   ```

   On macOS the directory is `~/Library/Application Support/Adobe/CEP/extensions`,
   and the debug flag is `defaults write com.adobe.CSXS.12 PlayerDebugMode 1`.

3. Restart Illustrator. The panel is under **Window > Extensions > SIML Export**.

## Using it

1. Open a document with text frames on the active artboard (a promo banner
   with a phone number is the ideal demo).
2. Pick a format, choose tiers, press **Export with SIML**.
3. A save dialog appears; the file is written locally.
4. Verify at https://siml-demo.vercel.app/view - drop the file, run the
   strip-and-recompress simulator, watch the text recover.

The T2 registry defaults to the deployed demo. If it is unreachable the
export continues with T0 + T1.

## How it works

- `host.jsx` (ExtendScript) walks `doc.textFrames`, keeps visible frames whose
  center sits on the active artboard, converts their `geometricBounds` to
  percentages of the artboard (y axis flipped - Illustrator points up), and
  rasterizes the artboard to a temp PNG at or above the canonical width.
- The panel (Chromium) decodes that PNG on a canvas, resamples to the
  1024-wide canonical grid (height a multiple of 8), embeds the dual-band QIM
  watermark, injects the JUMBF box into the encoded bytes, and saves through
  `cep.fs.showSaveDialogEx` + `cep.fs.writeFile` - no Node.js flag needed.
- The engine block in `main.js` is copied verbatim from
  `packages/siml-photoshop/main.js` (markers `ENGINE_START`/`ENGINE_END`).
  If you change one, re-copy to the other; a byte-diff of the section should
  always be empty.

## Limits

- One artboard per export (the active one). Text frames on other artboards
  are skipped.
- Point text and area text both work; text on a path exports with its
  bounding box, which can be wider than the visible glyphs.
- The raster is what Illustrator's PNG24 export produces at 72 dpi times the
  computed scale; effects that rasterize differently at other resolutions
  follow Illustrator's own export behavior.
