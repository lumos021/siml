# SIML Export - Figma plugin

Exports the selected frame as a PNG whose text stays selectable, copyable, and
machine-readable: the full text layer rides in a JUMBF container (T0), the
primary field in an invisible dual-band pixel watermark (T1), and the image's
perceptual fingerprint is registered for screenshot-grade recovery (T2).

Unlike the demo editor, the text layer here comes straight from the design:
exact strings and exact geometry from Figma's text nodes, no burning step.

## Run it (development mode)

1. Figma desktop app: menu → Plugins → Development → Import plugin from manifest
2. Pick `packages/siml-figma/manifest.json`
3. Select a frame with text in it → Plugins → Development → SIML Export
4. Choose tiers (T1 watermark, T2 registry) and press Export

The registry URL defaults to the local demo (`http://localhost:3000/api/registry`);
point it at the deployed registry once live. If the registry is unreachable the
export continues with T0 + T1 only.

## What it writes

- PNG at canonical width 1024 (height rounded to the 8-pixel watermark grid)
- `siMl` chunk: full layer JSON (types, intents, %-bounds, pixelDigest)
- T1: the first phone number found (or the marked primary), never truncated
- T2: whole-image pHash + distinguishing-region hash (spec 5.3.1)

Verify an export by dropping it into the demo viewer (`/view`) and running the
strip-and-recompress simulator.

## Engine note

The embedding engine in `ui.html` is a verbatim port of the validated
`siml-writer` code (dual-band QIM, prime-padded stream, RS + CRC fail-loud,
5.3.1 region hash). The same engine drops into any host with a JS surface:
Canva Apps SDK, Adobe Express add-ons, Photoshop UXP. Figma is first because
its plugin API is the most open; it is the template, not the destination.
