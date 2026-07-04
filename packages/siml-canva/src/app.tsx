// SIML Export - Canva app.
// Reads the current page's text elements (exact strings + geometry via the
// Design Editing API), exports the design as PNG (requestExport), embeds the
// SIML tiers with the shared engine, and downloads the result.
import { useState } from "react";
import { Button, Rows, Text, Title, FormField, TextInput, Checkbox } from "@canva/app-ui-kit";
import { openDesign, requestExport, getDefaultPageDimensions } from "@canva/design";
import { requestOpenExternalUrl } from "@canva/platform";
import {
  embedWatermark, selectT1Payload, pHashOfCanvas, regionHashOf,
  serializeJUMBF, injectPNG, ACTIONABLE,
} from "../../siml-engine";
import type { LayerObject } from "../../siml-engine";
import * as styles from "styles/components.css";

function inferType(text: string): string {
  const t = text.trim();
  if (/^[+()\d][\d\s\-().]{6,}$/.test(t) && (t.match(/\d/g) || []).length >= 7) return "phone";
  if (/^(https?:\/\/|www\.)\S+$/i.test(t)) return "url";
  if (/^\S+@\S+\.\S+$/.test(t)) return "email";
  return "text";
}

export const App = () => {
  const [t1, setT1] = useState(true);
  const [t2, setT2] = useState(true);
  const [registry, setRegistry] = useState("https://siml-demo.vercel.app/api/registry");
  const [log, setLog] = useState<string[]>(["Open a design with text, then press Export."]);
  const [busy, setBusy] = useState(false);
  const say = (m: string) => setLog((l) => [...l, m]);

  async function readLayer(): Promise<LayerObject[] | null> {
    let layer: LayerObject[] | null = null;
    await openDesign({ type: "current_page" }, async (session) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const page = session.page as any;
      if (!page || !page.elements) return; // unsupported page kind

      const els: {
        type: string; top: number; left: number; width: number; height: number;
        text?: { readPlaintext(): string };
      }[] = [];
      page.elements.forEach((e: (typeof els)[number]) => els.push(e));

      // Page dimensions when exposed; else Canva's default page size; else the
      // union of element extents.
      let pageW: number = page.dimensions?.width ?? 0;
      let pageH: number = page.dimensions?.height ?? 0;
      if (!pageW || !pageH) {
        const dims = await getDefaultPageDimensions();
        pageW = dims?.width ?? 0;
        pageH = dims?.height ?? 0;
      }
      if (!pageW || !pageH) {
        for (const e of els) {
          pageW = Math.max(pageW, e.left + e.width);
          pageH = Math.max(pageH, e.top + e.height);
        }
      }
      if (!pageW || !pageH) return;

      let sawPrimary = false;
      const out: LayerObject[] = [];
      let i = 0;
      for (const e of els) {
        if (e.type !== "text" || !e.text) continue;
        const text = e.text.readPlaintext().trim();
        if (!text) continue;
        const type = inferType(text);
        const primary = !sawPrimary && type === "phone" ? (sawPrimary = true) : false;
        out.push({
          id: "t" + ++i,
          text,
          type,
          intent: ACTIONABLE.has(type) ? "actionable" : "auto",
          primary: primary || undefined,
          bounds: {
            x: +((100 * e.left) / pageW).toFixed(2),
            y: +((100 * e.top) / pageH).toFixed(2),
            w: +((100 * e.width) / pageW).toFixed(2),
            h: +((100 * e.height) / pageH).toFixed(2),
          },
        });
      }
      out.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
      layer = out;
    });
    return layer;
  }

  async function run() {
    setBusy(true);
    setLog([]);
    try {
      say("Reading text elements from the design...");
      const layer = await readLayer();
      if (!layer) { say("Could not read this page (unsupported page type)."); return; }
      say(`Found ${layer.length} text element(s).`);

      say("Requesting PNG export (complete the export dialog)...");
      const exp = await requestExport({ acceptedFileTypes: ["png"] });
      if (exp.status !== "completed") { say("Export cancelled."); return; }
      const first = exp.exportBlobs[0];
      if (!first) { say("Export returned no files."); return; }

      // Canva serves the exported PNG from a remote host. Fetching it and
      // drawing it to a canvas would TAINT the canvas (cross-origin), making
      // canvas.toBlob() return null - i.e. "everything runs but nothing
      // downloads". We avoid the taint by turning the bytes into a same-origin
      // blob: URL and loading THAT into the image, so the canvas stays clean.
      say("Downloading the exported image...");
      let srcBlob: Blob;
      try {
        const resp = await fetch(first.url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        srcBlob = await resp.blob();
      } catch (e) {
        say(`Could not download the export (${(e as Error).message}). In the Developer Portal, add the export host to Permissions -> Domains: "https://export-download.canva.com" and "https://*.canva.com".`);
        return;
      }
      const exportBlobUrl = URL.createObjectURL(srcBlob);
      const bmp = await new Promise<HTMLImageElement>((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error("could not decode the exported PNG"));
        im.src = exportBlobUrl;
      });

      // Canonical grid: width 1024, height rounded to the 8-pixel block grid.
      const W = 1024;
      const H = Math.max(8, Math.round(((bmp.naturalHeight / bmp.naturalWidth) * W) / 8) * 8);
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      if (!ctx) { say("Canvas unavailable."); URL.revokeObjectURL(exportBlobUrl); return; }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bmp, 0, 0, W, H);
      URL.revokeObjectURL(exportBlobUrl);
      let img: ImageData;
      try {
        img = ctx.getImageData(0, 0, W, H);
      } catch {
        say("The image canvas is cross-origin tainted, so it can't be read. Add the Canva export host to the app's Permissions -> Domains in the Developer Portal, then retry.");
        return;
      }

      const contentId = "siml-" + Date.now().toString(36);

      let t1Mode: string | null = null;
      if (t1) {
        const sel = selectT1Payload(layer, contentId);
        if (sel) {
          const p = new Uint8Array(16);
          p.set(new TextEncoder().encode(sel.value));
          const stat = embedWatermark(img.data, W, H, p);
          ctx.putImageData(img, 0, 0);
          t1Mode = sel.mode;
          say(`T1 embedded (${sel.mode}, ${stat.placement} placement): "${sel.value}"`);
        } else {
          say("T1 skipped: no field fits the 16-byte watermark (add a phone text box).");
        }
      }

      const pixelDigest = pHashOfCanvas(canvas);
      const textLayer = layer.map((o) => ({
        ...o,
        primary: o.primary || undefined,
        runs: [{ bounds: o.bounds, text: o.text }],
        selectable: true,
        label: null,
      }));
      const payload = {
        siml: "0.3",
        contentId,
        pixelDigest,
        binding: { t0: true, t1: !!t1Mode, t2, ...(t1Mode ? { payloadMode: t1Mode, canonicalWidth: W } : {}) },
        image: { width: W, height: H },
        permissions: { platformCanDisableSelection: true, platformCanDisableLinks: true, platformCanDisableAll: false },
        textLayer,
      };

      if (t2) {
        const dhash = pHashOfCanvas(canvas);
        const regionObj = textLayer.find((o) => o.primary) ||
          textLayer.find((o) => ACTIONABLE.has(o.type) && o.intent !== "readonly") || textLayer[0];
        const body: Record<string, unknown> = { ...payload };
        if (regionObj) {
          body.regionHash = regionHashOf(canvas, regionObj.bounds);
          body.regionBounds = regionObj.bounds;
        }
        try {
          const res = await fetch(registry.trim(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ hash: dhash, payload: body }),
          });
          say(res.ok ? "T2 registered." : `T2 registration failed (HTTP ${res.status}) - continuing.`);
        } catch {
          say("T2 registry unreachable - continuing without it.");
        }
      }

      const outBlob: Blob | null = await new Promise((r) => canvas.toBlob(r, "image/png"));
      if (!outBlob) { say("PNG encode failed (canvas may be cross-origin tainted - add the export host to the app's Domains permission)."); return; }
      const finalBytes = injectPNG(new Uint8Array(await outBlob.arrayBuffer()), serializeJUMBF(payload));

      // Canva's sandbox closes every LOCAL download path (programmatic <a>
      // click, data: URL, LinkButton) - requestOpenExternalUrl accepts https:
      // only. So the file is stashed on the SIML server (HTTPS in prod) and its
      // download URL opened via that approved flow. Requires an HTTPS Registry
      // URL reachable from the browser (the deployed demo; localhost http will
      // be blocked as mixed content).
      say(`Done. Written tiers: T0${t1Mode ? ` + T1 (${t1Mode})` : ""}${t2 ? " + T2" : ""}. Preparing download...`);
      const origin = (() => { try { return new URL(registry.trim()).origin; } catch { return ""; } })();
      if (!origin.startsWith("https://")) {
        say("Download needs an HTTPS SIML server: set the Registry URL to your deployed demo (https://...), not localhost. The layer was still embedded - you can also verify by re-exporting to that server.");
        return;
      }
      try {
        const res = await fetch(`${origin}/api/stash?name=design`, {
          method: "POST",
          headers: { "Content-Type": "image/png" },
          body: finalBytes.buffer as ArrayBuffer,
        });
        if (!res.ok) { say(`Could not prepare the download (HTTP ${res.status}).`); return; }
        const { id } = await res.json();
        const dl = `${origin}/api/stash?id=${id}`;
        const opened = await requestOpenExternalUrl({ url: dl });
        say(opened.status === "completed"
          ? `Download opened in a new tab: ${dl}`
          : "Download link was dismissed - copy it from the log if needed.");
      } catch {
        say("Could not reach the download service. Ensure the HTTPS Registry URL is correct and its domain is allowed in the app's external-URL permissions.");
      }
    } catch (err) {
      say("Failed: " + (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.scrollContainer}>
      <Rows spacing="2u">
        <Title size="small">Export with SIML</Title>
        <Text size="small">
          Exports this design as a PNG whose text stays selectable, copyable, and
          machine-readable, surviving re-compression and messaging apps. The first
          phone number found is carried in an invisible pixel watermark.
        </Text>
        <Checkbox
          checked={t1}
          onChange={(_, checked) => setT1(checked)}
          label="T1 pixel watermark (offline recovery; imperceptible pixel change)"
        />
        <Checkbox
          checked={t2}
          onChange={(_, checked) => setT2(checked)}
          label="T2 registry fingerprint (screenshot-grade recovery; needs the registry)"
        />
        <FormField
          label="Registry URL"
          value={registry}
          control={(props) => <TextInput {...props} onChange={setRegistry} />}
        />
        <Button variant="primary" onClick={run} disabled={busy} stretch>
          {busy ? "Working..." : "Export with SIML"}
        </Button>
        <Text size="xsmall" tone="tertiary">{log.join(" | ")}</Text>
      </Rows>
    </div>
  );
};
