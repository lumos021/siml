# SIML - Selectable Image Markup Language
## Format Specification v0.3 (Draft)

**Status:** Working Draft
**Created:** June 2026
**Revised:** June 2026 - reconciled with reference implementations
(`siml_watermark.py`, `siml_preserve.py`): perceptual-masking guidance corrected
(§4.4), measured boundaries updated incl. q30 floor and CRC-reject (§4.6),
registry wire protocol now drafted (§5.4 → INTEGRATION.md §8); action-control model
made explicit with an optional `intent` field (§8.1) and anti-cloaking promoted to
a normative MUST bound to action-enabling (§9.2); added `primary` flag + T1
payload-selection rule with no-truncation guarantee (§4.5.1, §8); added staleness /
`pixelDigest` rule for edit-collision detection (§9.3); ratified T2 threshold ≤24
with false-match-margin caveat (§5.3); added near-duplicate failure mode +
mandatory pixel-verification rule for T2 (§5.3.1).
**Supersedes:** v0.2
**License:** Creative Commons CC0 1.0 (Public Domain)

---

## 0. What Changed Since v0.2 - and Why

v0.2 bound the text layer to the file **container** (a JUMBF box). That is fast,
lossless, and rich, but it dies the instant any pipeline re-encodes pixels,
which is exactly what social platforms and many CMS optimizers do. v0.2 admitted
this and punted "survive re-encode" to a vague future registry.

v0.3 closes that gap with measured engineering. The text layer is now bound at
**three independent tiers**, each owning a different degradation region, validated
by experiment (§4.6 reports the actual numbers):

```
                          survives        survives        survives
                          file copy /     re-encode +     downscale+recompress,
TIER                      email / CDN      moderate scale  screenshots, q20
─────────────────────────────────────────────────────────────────────────────
T0  Container (JUMBF)       ✅ lossless      ❌              ❌
T1  Pixel watermark          ✅              ✅ (moderate)    ❌
T2  Fingerprint + resolver   ✅              ✅              ✅ (needs registry)
─────────────────────────────────────────────────────────────────────────────
Crop / rotation / photo-of-screen: weakly covered → graceful fallback to visible
text + OCR (the commodity floor). Never claimed as solved.
```

Concrete changes:

- **Tier model formalized.** T0 (container) is v0.2. **T1 (robust pixel
  watermark)** and **T2 (perceptual-fingerprint resolver)** are new and validated.
- **INV-01 reversed (deliberately).** v0.1/v0.2 forbade modifying the raster. T1
  *intentionally* perturbs pixels imperceptibly to buy re-encode survival. v0.3
  defines exactly which tiers are lossless and which are lossy (§3).
- **Measured robustness boundaries become normative language** (§4.6) instead of
  marketing claims. Where the watermark dies is written into the spec.
- **Reader resolution order defined** across all tiers, with OCR as the final
  fallback (§6).
- **The "survives social media" capability is correctly attributed** to T2 (which
  needs a registry), never to the offline watermark (§7).
- **Registry/resolver promoted** from "future Tier 3" to a real, specified tier
  (§5.3), with open/decentralized governance requirements.

---

## 1. Abstract

SIML preserves human-authored text as selectable, copyable, semantically-typed
objects co-located with an image - without OCR at read time, and without a new
file extension. It is the image equivalent of a PDF text layer, hardened for the
real world: the same text is bound to the image at three tiers so it survives the
distribution channel's degradation, from lossless file copy all the way to
social-media recompression.

No single mechanism survives everything; SIML layers three so that each covers the
others' failure regions.

---

## 2. The Three Tiers at a Glance

| Tier | Binds to | Carries | Survives | Cost |
|---|---|---|---|---|
| **T0 Container** | the file (JUMBF box) | full layer: many objects, positions, styles | any non-re-encoding pipeline | dies on re-encode |
| **T1 Watermark** | the luminance pixels | short typed fields (phone/email/url/price), or a compact ID | re-encode, moderate downscale, offline | lossy (imperceptible), capacity-limited |
| **T2 Fingerprint** | the image's appearance | an ID resolved to the full layer via registry | aggressive downscale, recompression, screenshots | needs a registry/network |

Authoring writes as many tiers as the creator opts into. T0 alone is the cheapest
and richest; T1 adds offline re-encode survival; T2 adds social-media survival.

---

## 3. Lossy vs Lossless - the INV-01 Reversal

v0.1 invariant INV-01 ("the raster is NEVER modified") is **retired**. It was
incompatible with re-encode survival, because surviving a pipeline that destroys
metadata *requires* putting the data where the pipeline can't strip it: the pixels.

v0.3 replaces it with a precise contract:

- **T0 is lossless.** Writing the container never alters a pixel. An image with
  only T0 is bit-identical in its raster to the un-watermarked original.
- **T1 is lossy-but-imperceptible.** Writing the watermark perturbs luminance.
  Measured PSNR in the reference embed is 46.7-49.0 dB across content classes
  (§4.6, dual-band placement) - visually negligible: smooth regions (the
  historical worst case) are either byte-untouched or carry the half-strength
  band (see the §4.4 dual-band note).
- **T2 is lossless.** The fingerprint is *computed from* the image; it does not
  change it. Only the registry entry is written.

A creator who requires a byte-exact raster uses **T0 + T2 only** (both lossless)
and accepts that re-encode survival then depends on the registry. A creator who
wants offline re-encode survival opts into **T1** and accepts the imperceptible
perturbation. This is a stated, opt-in trade - never silent.

---

## 4. Tier 1 - Robust Pixel Watermark

### 4.1 Purpose

Carry a small, high-value payload **in the pixels** so it survives re-encoding
that strips all metadata (T0), fully offline, with no registry. The killer case:
a phone number / price / short URL on a banner, recoverable after a JPEG/WebP
recompression that obliterates the JUMBF box.

### 4.2 Method (Reference)

- Work on the **luminance (Y)** channel in **8×8 JPEG-aligned blocks**.
- For each block, take the 2-D DCT and embed one payload bit into a single
  **low-mid frequency coefficient** (reference: position (2,1)) via
  **quantization index modulation (QIM)** with step `Q` (reference: 26).
- **Repeat every payload bit across many blocks** (reference image 1024×512 ⇒
  ~128 repetitions per bit) and **majority-vote** on extraction. Redundancy is
  what buys robustness.
- Error-correction coding (BCH/Reed–Solomon) MAY replace naive repetition for
  better capacity-at-equal-robustness.

### 4.3 Canonical-Resolution Protocol (Synchronization)

The watermark depends on the 8×8 block grid, which any resize destroys. The fix
is **not** Fourier–Mellin; it is a protocol constant:

- The embedder canonicalizes the image to a **fixed reference grid** before
  embedding (reference: width 1024, height to nearest multiple of 8).
- The decoder, given a delivered image of any size, **renormalizes to the same
  reference width** (using the delivered aspect ratio to set height) before
  reading. This re-locks the grid for any **uncropped** scaling.
- A 16-bit **sync tag** in the payload acts as a validity oracle: a decoder MAY
  search a small range of candidate reference widths and accept the one whose tag
  verifies (handles minor aspect/rounding drift).

### 4.4 Capacity and Invisibility

- **Capacity (robust, invisible):** tens to low-hundreds of bits. A phone number
  is ~40 bits; a price ~20; a short URL/email a couple hundred. These fit
  directly. Richer layers do **not** fit - use an ID (§5) instead.
- **Invisibility:** the robustness/invisibility/capacity triangle is real.
  Louder embedding survives more but shows artifacts. Reference PSNR ~39 dB.
- **Perceptual masking - CAUTION (corrected by reference implementation).** Naive
  per-block adaptive embedding strength is **discouraged**: the reference
  `siml_watermark.py` measured that varying the QIM step by local texture
  *desynchronizes under scaling* - downscaling shifts the texture measure, so
  embedder and decoder disagree on the step and the ds900 case that fixed-step
  handles **breaks**. Any masking scheme MUST therefore be **scale-invariant or
  derived from the decoded (post-resync) grid**, never from raw per-block content
  that an attack can shift. When in doubt, use a **fixed step** - it outperformed
  both adaptive masking and spread-spectrum in testing.
- **Dual-band placement (universal visibility fix, measured 2026-07-02).**
  Blocks are classified by texture (luminance std-dev, threshold 8). On
  texture-rich images, smooth blocks (skies, gradients) are left
  **byte-untouched** and the payload rides only under texture at full strength
  (Q=26, margin-band). On low-texture images, smooth blocks carry a
  **half-strength band** (exact snap on Q=13 levels - visually clean amplitude)
  while any textured blocks keep full strength, so coverage is universal with
  no visible grain on any content class. This is a PLACEMENT/STRENGTH-CLASS
  rule with a fixed, protocol-known pair of quantizers - not a per-block
  adaptive step (the trap below): bit assignment is positional (blockIndex mod
  bitLength), so classifier disagreement over any block costs one vote, never
  a desync; the decoder re-derives the classification from delivered pixels
  and runs three attempts (textured-only, dual-band, legacy full), each gated
  by the sync tag + RS + CRC. Measured across four content classes (real
  photos, sky gradient, white flyer, banner): 46.7-49.0 dB PSNR and JPEG
  q85..q30 plus WebP q90 all recovered, on every class.
- The validated recipe is: **fixed-step QIM on a low-mid coefficient + soft-
  decision voting + Reed-Solomon ECC + a CRC that rejects miscorrections** so a
  bad read fails loudly instead of returning a wrong value. (See §4.6.)
- Payloads SHOULD be **tiled with full redundancy along image rows** so that a
  full-width horizontal strip recovers the whole payload (limited crop tolerance).

### 4.5 Payload Modes

| Mode | Watermark carries | Recovery |
|---|---|---|
| `direct` | the typed value itself (phone/email/url/price) | fully offline |
| `id` | a compact content ID | resolved to full layer via T2 registry (network) |

`direct` is the offline 80% case for banners/listings/menus. `id` is used when
the layer is too rich for the watermark's capacity.

#### 4.5.1 Which field the watermark carries (normative)

T1 has room for **one** short field, so a writer MUST select exactly one, by this
precedence:

1. The object marked **`primary: true`** (see §8), if any.
2. Else the **first object in reading order with `intent: "actionable"`**.
3. Else **skip T1** - not every image needs a pixel payload. (T0/T2 still apply.)

Capacity rule - **never truncate:**

- If the selected field's value **fits** T1's capacity, embed it verbatim
  (`direct` mode).
- If it does **not** fit, embed the layer's **`contentId`** instead (`id` mode)
  and let T2 resolve the full value. A writer MUST NOT embed a truncated value  - 
  half a phone number or a clipped URL is a *wrong* value, which violates the
  fail-loud guarantee (§4.6). Truncation is a conformance failure.

At most one `primary: true` object may exist per layer; if more than one is
present, readers/writers use the first in reading order and SHOULD warn.

### 4.6 Measured Robustness (Normative Reference Numbers)

Two reference builds were measured. The **production reference**
(`siml_watermark.py`: fixed-step QIM + soft-decision + RS + CRC) supersedes the
earlier spike; numbers below are from it (1024×512, dual-band placement:
textured blocks Q=26 margin-band 18, smooth blocks Q=13 exact-snap or
byte-untouched, 46.7-49.0 dB PSNR measured across photo/sky/flyer/banner
classes, phone-number payload). "Decoded" means the CRC validated - a failed CRC returns nothing rather
than a wrong value.

| Channel transform | Result |
|---|---|
| No attack | ✅ decoded |
| **JPEG q30**, q40, q60 | ✅ decoded *(q30 floor - improved over the spike's q40)* |
| **Double** JPEG | ✅ decoded |
| WebP | ✅ decoded at q90 across all measured content classes (dual-band); below q90 content-dependent (always a loud reject, never a wrong value) |
| Screenshot-style (downscale 0.85 + noise + q70) | ✅ decoded |
| Downscale **only** → renormalize to canonical | ✅ to ~480px width; degrades by ~400px |
| Downscale **+ recompression** | content-dependent below full size (structured banners may survive to ~900px) → loud CRC reject, **never a wrong number**; that region is T2's job |
| Crop (full-width, on-grid) | ✅ via row redundancy |
| Crop (loses width / off-grid / repasted) | ❌ → T2 / OCR |

The CRC is normative: a recovered payload that fails its integrity check MUST be
discarded, not surfaced. Failing loud beats returning a confidently-wrong value.

**Normative consequence:** T1 is reliable for re-encode at preserved or high
delivery resolution. It is **not** reliable for aggressive downscale-plus-
recompression (the typical social-media transform below ~900px). That region is
**T2's responsibility (§5)**, and implementations MUST NOT advertise T1 as
surviving it.

---

## 5. Tier 2 - Perceptual Fingerprint + Resolver

### 5.1 Purpose

Recover the full text layer for images that have been degraded past T1's limit  - 
aggressive downscale, recompression, screenshots - by matching the image's
*appearance* against a registry, with no metadata and no watermark required. This
is the only tier that survives the social-media death zone, and it also enables
attaching a layer to images **never authored as SIML**.

### 5.2 Method (Reference)

- At author time, compute a **perceptual hash** of the image (reference: 256-bit
  pHash) and store `hash → {full SIML payload}` in the registry.
- At query time, compute the query image's perceptual hash and retrieve the
  nearest registry entry by Hamming distance, subject to a match threshold.

### 5.3 Measured Discrimination (Normative Reference Numbers)

Measured over an 8-image registry, 256-bit pHash:

| Query (T1 had failed these) | dist to correct | dist to nearest wrong | retrieved |
|---|---|---|---|
| downscale 640 + JPEG60 | 4 | 58 | ✅ |
| downscale 480 + JPEG60 | 0 | 58 | ✅ |
| downscale 320 + JPEG60 | 2 | 58 | ✅ |
| screenshot sim | 4 | 58 | ✅ |
| double screenshot | 4 | 60 | ✅ |
| JPEG q20 (brutal) | 4 | 58 | ✅ |
| rotate 5° | 110 | 118 | ⚠️ thin margin |
| crop to band | 114 | 108 | ❌ |

Legitimate matches sit at distance **0–4**; different images sit at **34–58**.
The wide gap is what makes retrieval low-false-positive.

- **Match threshold:** the original 8-image synthetic reference suggested ≤ 12 on
  256-bit pHash. Real-image testing shows distances run higher (more visual
  similarity between real images), so the **ratified reference threshold is ≤ 24**,
  valid **only while the false-match margin holds** - different images MUST sit
  comfortably above 24 (target ≥ 35) on a real, distinct test set. An
  implementation MUST verify this margin on its own corpus and pin the chosen
  value in its conformance suite; if different images approach the threshold, it is
  too loose and resolving a *wrong* layer (a fail-loud violation) becomes possible.
  Above the threshold → no match.
- **Rotation** survives but with a thin margin; **crop** is not recoverable by
  global hash. Local-feature matching (ORB/SIFT) MAY be added for crop/rotation
  on content-distinctive imagery, but is unreliable on template-like images and
  is OPTIONAL.

#### 5.3.1 The near-duplicate failure mode (and why verification is mandatory)

The §5.3 reference margin (legit ≤18, distinct ≥122) was measured on **visually
dissimilar** images. It does **not** characterize the realistic case: a registry
holding many **near-duplicate** images - e.g. dozens of property listings from one
template differing only in a phone number, the normal state for a single real
customer.

A perceptual hash keeps **broad structure** and discards **fine detail** - but on
template images the broad structure is the *shared* 95% and the discarded detail is
the *distinguishing* 5% (the actual number). Two such images can sit only ~8–10
bits apart, **inside any usable threshold**. A screenshot of listing A can then
resolve to listing B and return **B's phone number for A's image** - a *confident
wrong answer*, which is strictly worse than no answer and a direct violation of the
fail-loud guarantee. T2 discrimination therefore **degrades as a single customer's
registry fills with similar images** - i.e. it gets less reliable precisely as it
is adopted.

**Normative consequence - a pHash match is a hypothesis, not an answer.** Before
surfacing any T2-recovered text, a reader **MUST** verify it against the query
image's own pixels:

1. **Candidate set, not single nearest.** The registry returns the nearest entry
   *and all neighbors within threshold*, not just the closest.
2. **Region disambiguation (SHOULD).** Store, in addition to the whole-image hash,
   a **fine-grained hash of the differing region(s)** (the layer's text `bounds`).
   Use it to choose among near-duplicate candidates - hashing the distinctive 5%,
   not the shared 95%.
3. **Pixel verification (MUST).** OCR the query image's region where the recovered
   field should appear and confirm the registry's answer is **consistent** with
   what is visible. If the registry says `+91 98765 43210` but the pixels read
   `+91 91111 22222`, **reject the match** and fall back. OCR is used here only as
   a *veto*, never as a *source*: it does not need to read the number, only to be
   good enough to reject a wrong one. If OCR is too degraded to verify, **reject**
   (fail-loud), do not guess.
4. **contentId shortcut.** If any T1 fragment carrying the `contentId` survives, it
   resolves the exact entry directly and verification is unnecessary - T2 guessing
   is the fallback only when the id is gone.

A registry expected to hold near-duplicate images that surfaces matches **without**
step 3 is non-conformant. Tight thresholds reduce the candidate set; they do not
make any single match trustworthy on similar imagery - verification does.

### 5.4 Registry Governance (Requirements, not yet a wire protocol)

To keep SIML open and CC0:

- The registry MUST be implementable as an **open, content-addressed** store
  (hash → payload); no single owner is required, and federated/decentralized
  hosting MUST be possible.
- Lookups SHOULD be privacy-preserving (e.g. prefix/bucket queries that do not
  reveal the exact image to the registry).
- A registry entry MUST be self-describing and signable so consumers can assess
  trust; SIML does not mandate a trust authority.
- The concrete query/response wire format is **drafted in `INTEGRATION.md` §8**
  (content-addressed lookup, hash-prefix privacy bucketing, signed entries) and
  will harden in a companion spec; v0.3 fixes the requirements above so
  implementations don't fork incompatibly.

---

## 6. Reader Resolution Order

A SIML-aware reader attempts tiers in fidelity order and stops at the first hit:

```
1. T0  Parse metadata boxes (JUMBF). If a SIML box / org.siml.textLayer.vN
       assertion is present and valid → use it. (Richest, lossless.)
2. T1  Else attempt watermark extraction: renormalize to canonical grid (§4.3),
       extract, verify the sync tag. If valid → use the watermark payload
       (direct), or resolve its ID via T2 (id mode).
3. T2  Else compute the perceptual hash and query the registry. If a match within
       threshold → use the resolved payload.
4. OCR Else fall back to on-device OCR / the visible text itself. SIML adds no
       claim here; this is the commodity floor and MUST NOT crash or error.
```

The text the human sees is always present in the raster regardless of tier - SIML
only changes whether a *machine* can recover it losslessly, and how much
degradation it survives.

---

## 7. Capability Matrix (What to Promise)

| Distribution path | Tier that saves it | Offline? |
|---|---|---|
| Direct file / email / CDN (no re-encode) | T0 | ✅ |
| Compliant editor re-encode, same size | T1 | ✅ |
| Recompression at preserved/high resolution | T1 | ✅ |
| Downscale only (to ~½ res) | T1 | ✅ |
| Aggressive downscale **+** recompression | **T2** | ❌ (registry) |
| Screenshot / screen-grab | **T2** | ❌ (registry) |
| Heavy crop / rotation / photo-of-screen | OCR + visible text | ✅ (lossy) |

**Marketing rule (normative):** "survives social media / screenshots" MAY be
claimed **only** for the T2 (registry) configuration. The offline configuration
(T0+T1) MUST be described as "survives re-encode and moderate downscale," not
"survives anything."

---

## 8. The Shared Text Layer Schema

Unchanged from v0.2 §5 (root `siml`/`image`/`permissions`/`textLayer`; text
objects with `id`/`text`/`type`/`bounds`/`runs`/`style`/`selectable`/`label`;
typed enum; per-line `runs`; expanded style object). v0.3 adds two optional
root fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `binding` | object | NO | Records which tiers were written: `{t0:bool, t1:bool, t2:bool}` and, for T1, the `payloadMode` (`direct`/`id`) and `canonicalWidth`. Informational; readers still detect tiers independently. |
| `contentId` | string | NO | The compact ID used by T1 `id` mode and the T2 registry key. Stable across re-exports of the same source. |

v0.3 also adds one optional **text-object** field, `intent`, to let the author
distinguish *actionable* from *read-only* semantics:

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `intent` | enum | NO | `actionable` | Author's intent for a typed object. `actionable` = the author *wants* the platform to offer the typed action (dial/open/navigate) where it can. `readonly` = the type is declared for accessibility/search/copy only; the author asks platforms **not** to offer the action. `auto` = no preference; platform decides. |
| `primary` | boolean | NO | `false` | Marks the one object the author considers most important - the field T1 carries when a watermark is written (§4.5.1). At most one per layer. |

`intent` is a **request, not a command** - consistent with the action model below.
It lets a coupon author mark a phone number as "dialable" or a fine-print URL as
"read-only, don't offer to open," without changing how selection or copy work.

### 8.1 The action-control model (who decides what happens on tap)

This is normative and answers "who controls the actions":

1. **The author declares _meaning and intent_, never behavior.** `type` says *what*
   a string is (phone/url/email/address/text); `intent` says whether the author
   *wants* it actioned. The author cannot force a platform to dial, open, or copy.
2. **The platform decides the _action_,** within the author's `permissions` limits
   (§5 v0.2) and `intent` request. The type enum's behaviors are **suggested**, not
   mandated - a platform may dial, may offer a menu, may only copy, or (if
   permitted) may do nothing. This freedom is deliberate: it is what lets OS/browser
   vendors adopt SIML without ceding control of their own UX.
3. **`permissions` are the author's hard boundaries** (what the platform may turn
   off); `intent` is the author's soft preference (what the platform is asked to
   offer); the platform's chosen **mode** (§8 v0.2: `full`/`button_only`/…) is how
   it expresses its decision. Order of authority: `permissions` (MUST) → platform
   choice → `intent` (SHOULD honor when acting).
4. **A platform that enables a typed action MUST honor §9.2 anti-cloaking** (below).
   Action-enabling and the reveal-before-act safeguard are a single obligation  - 
   you do not get to wire `tel:`/`window.open` without the reveal step.

The `siml` version field becomes `"0.3"`. All v0.2 forward-compatibility rules
(§14 there) carry over unchanged: unknown fields ignored, enums degrade, required
fields append-only, unknown major → raster only.

---

## 9. Style, Rendering, Anti-Cloaking, Accessibility

Unchanged from v0.2 §6–§10 and still normative:

- **Style & font handling (§6 v0.2):** in transparent-selection mode style is
  *geometric* (alignment via per-run bounds + box-fit), color is ignored; in
  reflow mode style is *visual*. Carried verbatim for round-tripping.
- **Dual-layer render contract**, **per-line runs**, **box-fit selection**,
  **EXIF-orientation reference frame**, **byte-for-byte copy fidelity**.
- **Anti-cloaking (§9 v0.2):** rendered text SHOULD match the raster; readers
  MUST surface the literal target before acting on url/phone/email/address. This
  is **more** important in v0.3 because T1/T2 can deliver text with no visible
  twin at all - so the "reveal raw text before acting" rule is mandatory across
  all tiers.
- **Accessibility (§10 v0.2):** empty `alt`, `role="text"` + `aria-label`,
  reading-order exposure, independent of visual mode.

### 9.2 Anti-cloaking is mandatory for any platform that enables actions

Because a SIML layer's text can differ from the visible pixels - and because T1/T2
can deliver text with **no visible twin at all** - typed actions are a phishing and
cloaking vector unless guarded. This is normative, not advisory:

1. A platform that enables a typed action (`phone`/`url`/`email`/`address`) **MUST
   surface the literal target to the user before acting** - e.g. "Call +91 98765
   43210?", "Open example.com?" - and act only on explicit confirmation. It **MUST
   NOT** auto-dial, auto-open, or auto-navigate on a bare tap/click.
2. The confirmation **MUST show the actual payload value**, not a label, a
   shortened form, or the visible-pixel text, so a divergence between what the user
   sees and what would happen is exposed before it happens.
3. For `url`, platforms **MUST** restrict schemes to a safe allow-list
   (`https`, `tel`, `mailto`, `geo`) and reject `javascript:`, `data:`, `file:`.
4. Rendered text **SHOULD** match the raster it overlays; a writer that emits a
   typed action whose value contradicts the visible glyphs is non-conformant.
5. These obligations apply **regardless of `intent`**: `intent: "actionable"` is the
   author asking for the action, never a waiver of the reveal step.

In short: enabling actions and the reveal-before-act safeguard are one indivisible
obligation. A platform may choose not to offer actions at all (per `permissions`
and its mode), but it may not offer them *without* the safeguard.

### 9.3 Staleness detection - the layer must match the pixels it describes

A SIML layer can become **silently wrong** when an image is edited by a tool that
re-encodes the pixels but copies the (safe-to-copy) container forward unchanged  - 
e.g. a designer fixes a typo or changes a phone number in Photoshop/Canva, which
are SIML-unaware. The visible pixels now say one thing; the layer still says the
old thing. This is the anti-cloaking failure (§9.2) occurring **by accident**, and
it is the most common real-world way a layer goes bad. It is normative to detect
it.

**Write side (MUST).** When writing a layer, the writer MUST store a **content
digest** of the region(s) the layer describes:

- A root field `pixelDigest` (string) = a hash of the **displayed-orientation,
  canonicalized** luminance of the image (reference: the same canonical grid used
  by T1, hashed - a perceptual-tolerant digest, not a raw byte hash, so ordinary
  re-compression does not trip it but *content edits* do).
- Optionally per-object digests for finer-grained staleness, but the root digest
  is the MUST.

**Read side (MUST).** On load, a reader MUST recompute the digest from the
delivered pixels and compare:

- **Match (within perceptual tolerance):** layer is *fresh* - render and offer
  actions normally.
- **Mismatch:** layer is **STALE**. The reader MUST NOT offer typed actions, MUST
  NOT present the layer text as authoritative, and SHOULD fall back to OCR / the
  visible text. It MAY show the stale text marked explicitly as unverified.

**Tolerance.** The digest is perceptual, not exact: it must survive the same
re-encode/downscale band T1 survives (so a CDN transcode does not falsely mark a
layer stale), but flip on a real content change (edited text, swapped number).
This is the pixel-side equivalent of T1's CRC: it makes accidental desync **fail
loud** instead of silently lying. Tune the staleness threshold against the same
real-image margin used for T2 (§5.3) so re-encode never trips it and edits always
do; pin the chosen threshold in the conformance suite.

**Editor obligation.** A SIML-aware editor that re-opens an existing layer MUST
recompute and rewrite `pixelDigest` on export if it re-burned pixels, so a
correctly-edited image carries a fresh digest rather than a stale one.

`pixelDigest` is an optional field for forward-compat (older readers ignore it and
simply skip staleness detection), but writing it is a MUST for v0.3 conformance and
reading it is a MUST where present.

---

## 10. Carrier Mechanics (T0)

Unchanged from v0.2 §4: JUMBF box, pinned UUID
`de6062e1-9e7b-494e-94b3-db6fcc257fdc`, JSON content-type box (brotli optional),
per-format placement (JPEG APP11, PNG `siMl` chunk, WebP `siML` chunk), unsigned
default tier + optional signed C2PA assertion `org.siml.textLayer.vN`,
skip-unknown fallback, decompression-bomb cap. The binary `.siml` container
remains removed.

---

## 11. Out of Scope for v0.3

Reserved for **additive (minor)** growth - safe to add later under the
forward-compat rules:

- Local-feature (ORB/SIFT) crop/rotation recovery as a formal T2 sub-mode.
- Multi-language alternate text; embedded-font reflow resource.
- Multi-scale / multi-frequency watermark for a lower downscale floor.

Reserved for a **major** version or companion spec:

- The T2 registry **wire protocol** (query/response, federation, privacy).
- Video/animation rasters; multi-page containers.

Permanently excluded:

- Code execution inside images; commerce/purchase triggers; DRM.

---

## 12. Reference Implementation (Planned)

| Component | Description |
|---|---|
| `siml-core` | Schema + validation + JUMBF I/O (T0) |
| `siml-watermark` | T1 embed/extract: fixed-step block-DCT QIM, canonical-grid resync, soft-decision voting, RS ECC + CRC reject (no adaptive masking - see §4.4). **The JS implementation (`packages/siml-writer/src/watermark.js` + `rs.js`) is now the canonical reference**, validated by the conformance suite; the original `siml_watermark.py` is historical. |
| `siml-fingerprint` | T2: perceptual hashing + open content-addressed resolver client |
| `siml-writer` | Orchestrates T0/T1/T2 per creator opt-in; one call, chosen tiers |
| `siml-reader` | Resolution order (§6): T0 → T1 → T2 → OCR; dual-layer render with box-fit |
| `siml-conformance` | Frozen fixtures **plus** the §4.6/§5.3 robustness suite as regression tests, so the measured boundaries can't silently drift |
| `siml-figma` / `siml-canva` | Export plugins emitting per-line runs and writing chosen tiers |

---

## 13. Honest Limitations (Stated, Not Buried)

- T1 trades byte-exact raster for re-encode survival (imperceptible, but real).
- T1 fails on aggressive downscale+recompression and most crops; T2 covers the
  former (with a registry) but not crop.
- T2 needs a registry/network for recovery; the visible text is always offline,
  but *machine* recovery of the rich layer is not, in that path.
- Crop/rotation/photo-of-screen are not solved; they fall back to OCR + the
  human-readable raster.
- The watermark encoder (fixed-step QIM + soft-decision + RS/CRC) is real signal-
  processing work, materially harder than writing a JUMBF box. Adaptive perceptual
  masking was tried and **discarded** - it desyncs under scaling (§4.4).

These are the cost of surviving the real world. The layered design exists
precisely because no single tier pays a smaller bill.

---

## 14. License

Released into the public domain under CC0 1.0. Anyone may implement, extend, or
build products on SIML without royalties or permission.

---

*End of SIML Specification v0.3*