# Integrating SIML

How any pipeline, viewer, or tool adds SIML support. Support is capability-based:
you implement only the level that fits what you already do, and you can verify
your implementation against the conformance suites in this repo.

Companion documents: [SIML-SPEC-v0.3.md](SIML-SPEC-v0.3.md) (the format),
[SIML-SPEC-v0.2.md](SIML-SPEC-v0.2.md) (carrier + schema details).

---

## 1. Integration levels

| Level | You do this if you... | Cost |
|---|---|---|
| **P · Preserve** | re-encode / optimize / transcode images | one function call |
| **R · Read** | want the text for search, indexing, accessibility | parse JSON |
| **X · Render** | display images and let users select/copy the text | overlay UI |
| **W · Write** | create or export images | author + embed |
| **F · Resolve** | help images survive non-preserving hops | registry participation |

The highest-leverage integration is **Preserve**: if your pipeline re-encodes
images, copy the SIML layer to your output and the text survives your
compression exactly, with no watermark fragility and no registry.

---

## 2. Level P - Preserve

Call the hook after your own re-encode step. It extracts the SIML layer from the
source bytes (if any) and re-embeds it into your output bytes, converting the
carrier between PNG / JPEG / WebP as needed. It never alters pixels.

```js
const { preserveLayer } = require('siml-writer')

const out   = await reencode(sourceBytes)             // your pipeline, unchanged
const final = await preserveLayer(sourceBytes, out)   // the layer survives you
```

CLI equivalent:

```bash
node packages/siml-writer/src/cli.js preserve -s original.png -o reencoded.jpg
```

Guarantees (verified by `packages/siml-writer/test/preserve.test.js`):

- Returns the output unchanged when there is no source layer, the output
  already has one, or the payload is not readably preservable. Never throws on
  malformed input.
- Enforces the payload size cap (4 MiB decompressed; 64 KB for JPEG APP11).
- Round-trips across PNG / JPEG / WebP, including cross-format conversion.
- Because coordinates are percentages, the layer survives resizing.

A Python reference with its own adversarial test suite is at
[siml_preserve.py](siml_preserve.py).

---

## 3. Level R - Read

Parse the T0 container and get the JSON layer:

```js
const { extractPayload } = require('siml-reader/src/extract')
const layer = await extractPayload(arrayBuffer)   // object or null, never throws
```

Required behavior (spec v0.2 §14, v0.3 §8):

- Match the JUMBF box on the pinned UUID `de6062e1-9e7b-494e-94b3-db6fcc257fdc`,
  not the label.
- Unknown box UUID, corrupt payload, oversized payload, or unknown major
  version: return nothing and show the plain image. No crash, no error surface.
- Ignore unknown JSON fields; degrade unknown enum values (unknown `type`
  becomes `text`). Never drop a layer over an unknown field.
- Copy is byte-for-byte UTF-8. No normalization.

---

## 4. Level X - Render

Render the raster, then overlay transparent selectable text:

- One absolutely-positioned span per `run` (per line), box-fit scaled so
  selection tracks the baked glyphs even without the original font.
- Accessibility: the `<img>` gets empty `alt`; spans carry `role="text"` and
  `aria-label` equal to their text, in reading order.
- **Anti-cloaking is mandatory if you enable typed actions** (spec §9.2): reveal
  the literal target before dialing / opening / navigating, act only on explicit
  confirmation, restrict URL schemes to an allow-list (`https`, `tel`, `mailto`,
  `geo`), and never auto-execute.
- **Staleness** (spec §9.3): recompute `pixelDigest` from delivered pixels; on
  mismatch, suppress actions and present the layer text as unverified.

The full resolution order (T0 → T1 → T2 → OCR fallback) is implemented in
`packages/siml-reader/src/resolve.js` (`resolveLayer`).

---

## 5. Level W - Write

```js
const { write } = require('siml-writer')

await write({
  imagePath, definition, outputPath,
  embedWatermark: true,   // T1: opt-in, alters pixels imperceptibly
  registerLocal:  true,   // T2: registers the perceptual hash
})
```

Writer obligations:

- EXIF orientation is applied before anything else; coordinates are percentages
  of the displayed image.
- T1 is an explicit opt-in (it perturbs luminance). The payload is selected per
  spec §4.5.1: the `primary` object, else the first actionable object, else T1
  is skipped. Values are never truncated; overflow falls back to `id` mode.
- `pixelDigest` (spec §9.3) is a MUST on write.
- T2 registration stores the whole-image hash plus a `regionHash` of the
  distinguishing field's bounds (spec §5.3.1) so near-duplicate templates stay
  separable.

---

## 6. Level F - Resolve

Run or query a registry node so degraded copies (screenshots, aggressive
downscales) can be matched back to their layer. See §8 for the wire protocol.

---

## 7. Security requirements (all levels)

- **Fail loud, never lie.** Any recovered payload must pass its integrity check
  before being surfaced: CRC for T1, Hamming threshold plus §5.3.1 pixel
  verification for T2. A wrong phone number is worse than no result.
- Decompression cap (4 MiB) on T0 payloads; reject oversized JPEG segments.
- URL scheme allow-list; reject `javascript:`, `data:`, `file:`.
- Never execute code from a payload. No commerce triggers. No DRM.
- Adversarial cases (truncated files, spoofed formats, oversized chunks,
  obfuscated schemes) are pinned in `packages/siml-reader/test/adversarial.test.js`.

---

## 8. Registry wire protocol (draft)

Content-addressed lookup, as implemented by the demo endpoint
(`packages/siml-demo/app/api/registry/route.ts`):

```
GET  /api/registry?hash=<64-hex 256-bit pHash>
     → { match, dist, key, candidates: [{ key, dist, entry }] }

POST /api/registry
     body { hash: <64-hex>, payload: <SIML layer JSON> }
     → { ok, hash }
```

Protocol requirements (spec §5.4, §5.3.1):

- The registry returns the **candidate set** (all entries within the match
  threshold, nearest first), not just the single nearest entry.
- A match is a hypothesis. The client must verify it against the query image's
  own pixels (region-hash veto, `REGION_MATCH_THRESHOLD`) before surfacing it,
  and reject on ambiguity.
- Entries should be self-describing and signable. The registry must be
  implementable as an open, federated, content-addressed store; no single owner.
- Lookups send a hash, never the image. Hash-prefix bucketing for stronger
  lookup privacy is planned for the hardened protocol revision.

---

## 9. Conformance

Run the suites before claiming a level:

```bash
npm test -w siml-writer   # writer, preserve, conformance (thresholds pinned)
npm test -w siml-reader   # reader, adversarial
```

The measured robustness boundaries (T1 JPEG q30 floor, T2 threshold 24 with
false-match margin, staleness threshold 10, region veto 40) are pinned as
regression tests in `packages/siml-writer/test/conformance.test.js` so they
cannot silently drift.

---

## License

CC0 1.0. Implement freely; no royalties, no permission needed.
