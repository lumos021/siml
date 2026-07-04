# SIML Export - Canva app

Exports the current Canva design as a PNG whose text stays selectable,
copyable, and machine-readable: the full text layer (exact strings + geometry
from the Design Editing API) rides in a JUMBF container (T0), the first phone
number in an invisible dual-band pixel watermark (T1), and the image's
perceptual fingerprint is registered for screenshot-grade recovery (T2).

Canva is where phone-number banners actually get made, which makes this the
distribution app; the engine (`src/siml-engine.ts`) is the same validated code
that powers the demo editor and the Figma plugin.

## Setup (development preview - no review needed)

Canva apps are built on Canva's official starter kit; this package contains
the two source files you drop into it.

1. Create a developer account and an app at https://www.canva.com/developers/
   (Developer Portal → Your apps → Create app).
2. Clone the starter kit and install:

   ```bash
   git clone https://github.com/canva-sdks/canva-apps-sdk-starter-kit
   cd canva-apps-sdk-starter-kit
   npm install
   ```

3. Copy this package's sources over the starter kit's:

   ```bash
   cp <siml-repo>/packages/siml-canva/src/app.tsx src/app.tsx
   cp <siml-repo>/packages/siml-canva/src/siml-engine.ts src/siml-engine.ts
   ```

4. `npm start` (serves http://localhost:8080).
5. In the Developer Portal, set **App source → Development URL** to the dev
   server's JS bundle URL shown by the CLI, then press **Preview**. Canva opens
   the editor with the app in the side panel; click **Open** to connect it the
   first time.

## Using it

1. Open any design with text on it (a promo banner with a phone number is the
   ideal demo).
2. Open the app panel → choose tiers → **Export with SIML**.
3. Complete Canva's export dialog (PNG). The app re-reads the raster, embeds
   the tiers, and downloads `design.siml.png`.
4. Verify by dropping the file into the demo viewer (`/view`) and running the
   strip-and-recompress simulator.

Registry URL defaults to the local demo (`http://localhost:3000/api/registry`);
point it at the deployed registry once live (the endpoint sends CORS headers,
so the Canva iframe can reach it). If unreachable, export continues with
T0 + T1.

## Notes and limits (v1)

- Text geometry comes from `openDesign` on the current page (absolute pages
  only - Canva Docs pages are not supported).
- One run per text element for now (same as the demo editor); Canva does not
  expose per-line boxes.
- The watermark rides the 1024-wide canonical grid; exports are normalized to
  it before embedding.
- Publishing to the Canva marketplace requires their app review; the preview
  flow above is private to your account and needs no review.
