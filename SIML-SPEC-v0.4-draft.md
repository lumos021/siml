# SIML v0.4 (DRAFT) - Verified Visible Text

**Status:** Experimental draft. Nothing here is normative yet; v0.3 remains the
current spec. A working prototype of the core mechanism lives at
`packages/siml-writer/scripts/verify-ocr-prototype.js` with measured results
(§6 below).
**License:** CC0 1.0

---

## 1. The idea: stop carrying the data, carry the proof

Every SIML tier so far fights a capacity war: it hides bits *next to* text that
is already printed on the image in glyphs hundreds of pixels tall. v0.4 inverts
that.

The **visible glyphs are the data channel**. The watermark carries only a tiny
**checksum** of the authored text. At read time, OCR reads the glyphs, and the
checksum turns OCR from a guesser into a verifier - and, more powerfully, into
a **search oracle**: when OCR is unsure (0 vs O, 1 vs l vs I, 8 vs B), the
reader enumerates the plausible readings and accepts the one whose checksum
matches. The result is the **exact, byte-for-byte authored text**, recovered
offline, from an image OCR alone would read wrong.

This is not a retreat from "no OCR." SIML's guarantee was never the absence of
OCR (naked OCR is already the v0.3 fallback floor, and §5.3.1 already uses OCR
as a veto); the guarantee is the absence of *unverified guessing*. Verify mode
extends the fail-loud contract to the one tier that lacked it.

## 2. What it buys

| Property | T1 `direct` (v0.3) | T1 `verify` (v0.4) |
|---|---|---|
| Text capacity | 16 bytes, one field | unlimited: a checksum covers any field length |
| Fields covered | exactly one | all checksummed fields |
| Positions | none (value only) | true glyph positions from OCR boxes |
| Payload stream | 192 bits | 112 bits today; 64-80 bits possible (§7) |
| Survival | to the §4.6 floor | measurably deeper (shorter stream = more redundancy per bit), then bounded by OCR's floor, which is far lower |
| Staleness | needs pixelDigest | self-proving: the checksum matched the *delivered* glyphs |

## 3. Payload format (`verify` mode)

Added to the §4.5 payload mode table:

| Mode | Watermark carries | Recovery |
|---|---|---|
| `direct` | the typed value itself | offline |
| `id` | a compact content ID | via T2 registry |
| **`verify`** | magic `V1` + checksum(s) of the normalized authored field(s) | offline: OCR + oracle search |

Prototype layout (6 bytes): `"V1"` + CRC32(normalized field). The ratified
version SHOULD use a truncated cryptographic hash (48-64 bits of SHA-256)
rather than CRC32: CRC is not collision-resistant against an adversary who
crafts a visually different value with the same checksum (§8).

## 4. Normalization (per type, normative when ratified)

The checksum is computed over a canonical form so OCR whitespace and styling
variance cannot break verification:

- `phone`: strip everything but digits and a leading `+`.
- `price`: strip whitespace; keep digits, decimal separator, currency symbol.
- `url` / `email`: trim; lowercase the host part; strip trailing punctuation.
- `text`: NFC, collapse internal whitespace runs to single spaces, trim.

Writers MUST document the normalization they applied (the mode byte versions
it: `V1` = this table).

## 5. Reader algorithm

1. Extract the T1 payload; if it opens with `V1`, enter verify mode.
2. OCR the delivered image (on-device; e.g. tesseract.js in browsers).
3. For each OCR line, consider word windows `[start, end)`. For each window:
   normalize, then run the **bounded oracle search**: enumerate combinations of
   standard OCR confusions (O/0, l/1/I, Z/2, S/5, B/8, G/6, g/9 ...) up to a
   hard cap (prototype: 4096 candidates); accept a candidate iff its checksum
   matches.
4. Among matching windows, choose the **tightest** (fewest words), so labels
   ("Call:") and trailing OCR junk do not inflate the result.
5. The recovered object's `bounds` = the union of the matching window's OCR
   word boxes, converted to %-coordinates of the delivered image. The overlay
   therefore renders on the true glyphs - position fidelity comes free.
6. **No candidate matches -> fail loud.** Surface nothing, fall through to T2.
   A verify-mode reader MUST NOT present unverified OCR output as verified.

Resolution order becomes:
`T0 -> T1 direct/id -> T1 verify (OCR + oracle) -> T2 -> naked OCR (explicitly unverified)`.

## 6. Prototype measurements (2026-07-02, 1024x512 banner, JPEG q75 chain)

| Attack | `direct` (16 B) | `verify` (6 B checksum) |
|---|---|---|
| q75 at full size | recovered | recovered |
| downscale 900 + q75 | dead (loud) | **checksum recovered; OCR read the line with junk ("+91 98765 43210 = ="); oracle verified the exact value; bounds hugged the glyphs** |
| downscale 800 + q75 | dead | dead (checksum gone; §7) |

Interpretation: the shorter stream already buys survival past `direct` mode's
floor, and the recovered value carries positions. The current bottleneck below
~800 px is the checksum watermark itself, not OCR (OCR still reads this banner
comfortably at 500 px). Shrinking the stream (§7) pushes the floor toward
OCR's, which is the theoretical limit of this design.

## 7. Open engineering (ordered)

1. **Shorter stream.** The inner CRC16 is redundant in verify mode (the
   checksum IS the integrity check): dropping it and using a 32-48 bit hash
   gives a 64-80 bit stream vs 192 for direct - 2.4-3x redundancy per bit.
2. **Multi-field packing.** `V2`: field count + per-field truncated hashes
   (e.g. 3 fields x 24 bits + magic in 16 bytes).
3. **Confusion model from OCR confidences.** Use per-symbol alternative
   choices emitted by the OCR engine instead of a static substitution table.
4. **Non-Latin scripts.** Normalization + confusion tables per script.
5. **Candidate-width search** in the decoder (§4.3 of v0.3 already permits it)
   so platform resizes cannot desync the canonical grid.

## 8. Security considerations

- **Checksum collisions.** An adversary who controls the image could craft a
  wrong visible value colliding with the checksum. Mitigations: truncated
  cryptographic hash (not CRC), and the v0.3 anti-cloaking rule (§9.2) still
  applies in full - verify mode changes what is *recovered*, never what is
  *acted on* without the reveal step.
- **Oracle abuse.** The candidate cap MUST be enforced; the search space is
  bounded and offline, so there is no oracle-service attack surface.
- **Downgrade honesty.** A reader MUST label naked-OCR results (final
  fallback) as unverified; only checksum-matched values may be presented with
  SIML's exactness claim.

## 9. Relationship to v0.3

Purely additive: a new payload mode and a reader stage. No carrier, schema, or
tier changes. v0.3 readers see an unknown payload mode and ignore it
(forward-compat rules, v0.2 §14).
