# SIML - Selectable Image Markup Language

**Make the text inside an image selectable, copyable, and machine-readable - like a PDF text layer, but for raster images, and hardened to survive real-world distribution.**

> Status: **complete** - spec v0.3 stable, reference writer/reader, live demo, design-tool exporters. This project is finished work, released whole into the public domain. It is not under active development; everything here is free to fork, implement, and build on without permission. · License: **CC0 1.0 (public domain)**
>
> **Live demo:** [siml-demo.vercel.app](https://siml-demo.vercel.app) - author an image in the editor, degrade it in the viewer's strip simulator, watch the text recover.
>
> [![tests](https://github.com/lumos021/siml/actions/workflows/test.yml/badge.svg)](https://github.com/lumos021/siml/actions/workflows/test.yml)

---

## The problem

Every time text is rendered into an image - a phone number on a property banner, a price on a menu, an address on a flyer - it becomes pixels. To get it back out you need OCR, an AI vision model, or a human retyping it. That's wasted effort for data that existed at the moment of export.

## What SIML does

SIML captures that text **at export time** and carries it *with the image* as selectable, semantically-typed objects (phone, email, url, address, price). A SIML-aware viewer lets you select and copy the text as if the image were a PDF; a non-aware viewer just sees a normal image.

The hard part isn't storing the text - it's making it **survive the journey**. A file emailed, served over a CDN, recompressed by a social platform, or screenshotted degrades in different ways. No single mechanism survives all of them, so SIML binds the text at **three independent tiers**, each covering the others' blind spots.

---

## The three tiers

| Tier | Binds to | Carries | Survives | Cost |
|---|---|---|---|---|
| **T0 · Container** | the file (a JUMBF box) | the **full** layer - many objects, positions, styles | any pipeline that doesn't re-encode pixels | dies on re-encode |
| **T1 · Watermark** | the **pixels** | a **short** typed field, or a compact ID | re-encode + moderate downscale, **fully offline** | imperceptible pixel change; low capacity |
| **T2 · Fingerprint** | the image's **appearance** | an ID resolved to the full layer | aggressive downscale, recompression, **screenshots** | needs a registry/network |

A reader tries them in fidelity order - **T0 → T1 → T2 → OCR/visible-text fallback** - and stops at the first hit. The visible text is always in the pixels, so a human can always read it; SIML is about letting a *machine* recover it losslessly and about how much degradation that recovery survives.

---

## What actually survives what (measured, not marketing)

| Distribution path | Recovered by | Offline? |
|---|---|---|
| Direct file / email / CDN (no re-encode) | T0 | ✅ |
| Recompression at preserved/high resolution | T1 | ✅ |
| Downscale only (to ~½ resolution) | T1 | ✅ |
| Downscale **+** recompression | **T2** (structured banners may also survive via T1 to ~900px) | ❌ (registry) |
| Screenshot / screen-grab | **T2** | ❌ (registry) |
| Heavy crop / rotation / photo-of-screen | OCR + visible text | ✅ (lossy) |

**Honesty rule baked into the project:** "survives social media / screenshots" is a **T2** capability (it needs the registry). The offline configuration (T0 + T1) is described as "survives re-encode and moderate downscale" - never "survives anything."

The Tier-1 watermark (canonical implementation: [`packages/siml-writer/src/watermark.js`](packages/siml-writer/src/watermark.js), pinned by the conformance suite) is measured at 46.7-49 dB PSNR across content classes (dual-band placement keeps smooth areas byte-untouched or at a visually clean half-strength) and recovers a phone number cleanly through JPEG q30+, high-quality WebP (q90+), double-compression, and screenshot-style transforms. Under aggressive downscale + recompression the signal is genuinely gone - so it **fails loudly** (a CRC rejects bad reads) rather than returning a wrong number, and hands off to T2.

---

## Quick start

```bash
# install all workspace dependencies from root
npm install

# run the Next.js editor + viewer + registry in dev mode
npm run dev

# run the full test suites (writer + reader, incl. T1 conformance floors)
npm test
```

Then open [http://localhost:3000](http://localhost:3000) - use the **editor** to place text objects on an image and write the tiers you want, and the **viewer** to select/copy the recovered text.

---

## Project structure

```
packages/
  siml-demo/       Next.js editor UI (/create), viewer (/view), and HTTP T2 registry (/api/registry)
  siml-reader/     Browser client-side JS SDK for JUMBF (T0), watermark (T1), and T2 resolve queries
  siml-writer/     Node.js CLI & server SDK for embedding JUMBF blocks and watermarking pixels
  siml-canva/      Canva app: export designs as SIML images (see its README for the starter-kit setup)
  siml-figma/      Figma plugin: export frames as SIML images
  siml-photoshop/  Photoshop UXP plugin: export documents as SIML images with native file save
  siml-illustrator/ Illustrator CEP extension: export artboards as SIML images
siml_watermark.py  Original Python T1 recipe (historical; the JS writer is canonical)
siml_preserve.py   Python reference hook to preserve metadata across third-party compressions
SIML-SPEC-v0.3.md  The current tri-tier format specification
INTEGRATION.md     Integration guidelines and API registry wire specifications
```

Maturity, honestly stated: the writer, reader, demo, and Canva app are tested
end to end (including through real messaging-app re-compression). The Figma,
Photoshop, and Illustrator exporters share the same verified engine but have
not been exercised inside their host apps; treat them as reference
implementations and test in your environment before relying on them.

---

## How it works

- **Editor** burns text into the raster exactly as a normal export would (no visual change), and *simultaneously* emits each text block as a structured, positioned object - then writes it to the tiers the creator opted into.
- **T0** stores the full layer as JSON inside a **JUMBF box** (the same container family as C2PA Content Credentials), placed in the image's native metadata slot. Unaware readers skip it and see a normal image.
- **T1** embeds a short payload into the luminance via a robust DCT watermark with a canonical-resolution resync step, so it survives recompression and moderate downscaling offline.
- **T2** stores a perceptual hash → full-layer mapping in a content-addressed registry, so even a screenshotted, recompressed copy can be matched back to its text.
- **Viewer** renders the raster, overlays transparent per-line text for native selection (box-fit so selection tracks the visible glyphs), and surfaces the literal target before any action - see *Safety* below.

Built with Next.js (App Router) + React.

---

## Integrating SIML

Any organization - a CDN, an image optimizer, a chat app, a browser/OS image viewer, a CMS - can add support at the level that fits, and make text layers **outlast their own compression**. Support is capability-based, so you adopt only what's useful:

| Level | You do this if you… | Cost |
|---|---|---|
| **P · Preserve** | re-encode / optimize / transcode images | one function call |
| **R · Read** | want the text for search, indexing, accessibility | parse JSON |
| **X · Render** | display images and let users select/copy the text | overlay UI |
| **W · Write** | create or export images | author + embed |
| **F · Resolve** | help images survive non-preserving hops | registry participation |

**The highest-leverage integration is _Preserve_:** if your pipeline re-encodes images, copy the SIML layer to your output and the text survives *your* compression perfectly - no watermark fragility, no registry. Because coordinates are percentages, it survives resizing too.

```js
const { preserveLayer } = require('siml-writer');

const out   = await reencode(sourceBytes);            // your pipeline, unchanged
const final = await preserveLayer(sourceBytes, out);  // the layer survives you
```

The reference hook ([`siml_preserve.py`](siml_preserve.py)) is **tested** - it round-trips payloads across PNG/JPEG/WebP, handles format conversion and resize, enforces a payload size cap, and passes an adversarial input suite (malformed files, oversized payloads, format spoofing). Full guide, SDK, registry protocol, and security testing requirements: **[INTEGRATION.md](INTEGRATION.md)**.

---

## Known limits

- **T1 alters pixels** (imperceptibly) to survive re-encoding - a stated, opt-in trade. A byte-exact raster means T0 + T2 only.
- **T1 fails** on aggressive downscale-plus-recompression and most crops; that region is T2's job (and T2 needs a network).
- **T2 needs a registry** for recovery; the visible text is always offline, but recovering the *rich* layer in that path is not.
- **Crop / rotation / photo-of-screen** are not solved - they fall back to OCR and the human-readable pixels.

---

## Safety: no confidently-wrong output, no cloaking

- Any payload recovered from T1/T2 must pass an integrity check (CRC / hash threshold) before it's shown. **Failing loud beats returning a wrong phone number.**
- Because T1/T2 can deliver text with no visible twin, the viewer **always surfaces the literal target** (the actual phone/URL/email) before dialing, opening, or navigating, and never auto-executes an action. Rendered text should match the raster.

---

## Relationship to prior art

SIML deliberately reuses standards rather than reinventing them:

- **Carrier** - rides **JUMBF** (ISO/IEC 19566-5), the same box mechanism **C2PA / Content Credentials** uses; SIML adds a selectable-text payload and an interaction model, not a new file format.
- **Positioned text regions** echo **IPTC Image Regions** (tagging) - SIML adds copy/selection semantics.
- **The invisible selectable overlay** is the decades-old **PDF text "sandwich,"** brought to web raster images.

The novelty is the **combination**: a positioned, copyable, semantically-typed text layer with a tiered survival model and a dual-layer render contract.

---

## Documentation

- [SIML-SPEC-v0.3.md](SIML-SPEC-v0.3.md) - current spec (tri-layer + measured robustness)
- [SIML-SPEC-v0.4-draft.md](SIML-SPEC-v0.4-draft.md) - draft: verified visible text (checksum-guided OCR, working prototype)
- [ROADMAP.md](ROADMAP.md) - directions the work could go, for anyone who picks it up
- [SIML-SPEC-v0.2.md](SIML-SPEC-v0.2.md) - the JUMBF carrier + text-layer schema
- [siml_watermark.py](siml_watermark.py) - the original Tier-1 recipe + self-test (historical; superseded by the dual-band JS writer, see spec §12)
- [siml_preserve.py](siml_preserve.py) - verified Level-P preservation hook + adversarial tests
- [INTEGRATION.md](INTEGRATION.md) - how anyone adds SIML support (conformance levels, SDK, registry protocol, security)

---

## Project status

This is completed work. The specification is stable at v0.3, the measured
claims are pinned by a conformance suite, the demo is deployed, and the whole
of it - spec, writer, reader, watermark, registry protocol, exporters - is
**CC0 (public domain)**: free to implement, fork, and build on, forever, with
no royalties and no permission needed.

There is no company behind this and no active development planned. If the
format is useful to you, take it - that is what the license is for. The
registry protocol is open and content-addressed, so anyone can run one; the
demo registry is a reference deployment, not a service commitment.

---

## FAQ

**How do I make text inside an image selectable and copyable?**
Author the image with a SIML writer (or the demo editor). The text is baked into the pixels as usual, and also carried as positioned, typed objects a viewer can overlay for native selection and copy. No OCR at read time.

**Is this just OCR?**
No. OCR *guesses* text from pixels and gets digits wrong. SIML carries the *exact authored text*, byte for byte, so a phone number or price is either recovered exactly or not at all. Every recovery path has an integrity check; a wrong value is never surfaced.

**How is this different from Apple Live Text or Google Lens?**
Those are OCR at read time: excellent for casual copying, but inferred, unstructured, and unaware of author intent. SIML is authoritative (written at export), semantically typed (phone/url/email/address/price), and carries author permissions and intent for actions.

**Does it survive WhatsApp, Instagram, or screenshots?**
Re-encoding at reasonable resolution: yes, offline, via the pixel watermark. Aggressive downscale and screenshots: yes, via the fingerprint registry (network needed). See the survival table above; the limits are measured and stated.

**Does it change how the image looks?**
T0 and T2 never touch a pixel. T1 (optional) perturbs luminance imperceptibly (46.7-49 dB PSNR measured across content classes) to survive re-encoding; it is an explicit opt-in trade.

**How does it relate to C2PA / Content Credentials?**
SIML rides the same JUMBF container C2PA uses and can be expressed as a C2PA assertion. It is complementary: C2PA answers "where did this image come from," SIML answers "what does the text in it say."

**Can AI models and crawlers read SIML images?**
Yes. Any parser that reads the JUMBF box gets the exact text, types, and positions as JSON, with no vision model inference. That makes image text reliably machine-readable for search, accessibility, and AI systems.

---

## License

Released into the public domain under **[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)**. Implement it, extend it, build products on it - no royalties, no permission needed.