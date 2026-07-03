# SIML Roadmap

Direction, honestly stated. Dates are intentions, not promises. Items move only
with measurements behind them; every robustness claim ships with a conformance
test pinning it.

## Now: launch (2026 Q3)

- [x] Public repo, CC0, clean history
- [x] T1 watermark restored and upgraded to dual-band QIM (RS restore fix,
      quantizer fix, clipping passes, textured placement + half-strength smooth
      band; 46.7-49 dB with q30 + WebP q90 passing on all measured content
      classes; floors pinned in C-T1-04..06)
- [ ] Deploy demo (Vercel) + registry endpoint on a persistent store
- [ ] Register the spec domain; samples registered in the HTTP registry
- [ ] Publish `siml-writer` / `siml-reader` to npm
- [ ] Real-world demo asset: editor -> WhatsApp -> offline recovery, on camera
- [ ] Show HN

## v0.4: verified visible text (draft in SIML-SPEC-v0.4-draft.md)

The capacity inversion: the watermark carries a checksum, the visible glyphs
carry the data, OCR + oracle search recovers the exact authored text with true
glyph positions. Prototype working (`scripts/verify-ocr-prototype.js`).

- [ ] Shorter verify stream (drop inner CRC16, truncated SHA-256): target
      2.4-3x per-bit redundancy vs direct mode
- [ ] Writer: `payloadMode: "verify"` behind an explicit flag
- [x] Demo: tesseract.js verify stage in the resolution order with the
      tightest-window position contract (validated through a real WhatsApp
      forward); reader-lib port still pending
- [ ] Confusion model from OCR per-symbol confidences
- [ ] Conformance suite `V-*` pinning the verify floor
- [ ] Ratify into SIML-SPEC-v0.4

## v0.4.x: classical hardening

- [ ] Decoder candidate-width search (spec §4.3 already permits it) so
      platform resizes cannot desync the canonical grid
- [ ] Digit packing for phone payloads (roughly half the direct-mode stream)
- [ ] WebP below q90 (q90 now passes on all measured classes via dual-band;
      deeper WebP floors may need a WebP-aligned variant)
- [ ] CLI: `--watermark` / `--register` flags
- [ ] Editor: multi-line text model with per-line runs

## v0.5: registry that isn't a mock

- [ ] Hardened wire protocol (INTEGRATION.md §8): signed entries,
      hash-prefix privacy bucketing, federation story
- [ ] Server-side §5.3.1 verification (region veto + OCR veto at the node)
- [ ] Hosted default node with free reads, metered writes

## Ecosystem (parallel, distribution-driven)

- [ ] Figma "Export with SIML" plugin (per-line runs come free from Figma's
      text nodes)
- [ ] CDN preserve() plugin (Cloudflare Workers / Lambda@Edge)
- [ ] C2PA assertion proposal (`org.siml.textLayer`) - SIML already rides JUMBF
- [ ] W3C WICG "text layer for images" proposal referencing the implementation

## Research track (no dates; success not guaranteed, stated openly)

- Learned steganography (StegaStamp lineage): encoder/decoder trained through
  differentiable attack simulation, targeting the regions the classical stack
  cannot reach - photo-of-screen, crop, rotation. The decoder contract stays
  fail-loud; the spec stays open.
- Scale-invariant perceptual masking (the v0.3 §4.4 trap, done right or not
  at all).

## Non-goals (permanent)

Code execution in payloads, commerce triggers, DRM, and any robustness claim
without a pinned measurement behind it.
