// SIML Export - Canva app.
// Reads the current page's text elements (exact strings + geometry via the
// Design Editing API), exports the design as PNG (requestExport), embeds the
// SIML tiers with the shared engine, and downloads the result.
//
// Drop this file (and siml-engine.ts) into Canva's apps-sdk-starter-kit `src/`
// - see the package README for the exact setup steps.
import React, { useState } from "react";
import { Button, Rows, Text, Title, FormField, TextInput, Checkbox } from "@canva/app-ui-kit";
import { openDesign, requestExport } from "@canva/design";
import {
  embedWatermark, selectT1Payload, pHashOfCanvas, regionHashOf,
  serializeJUMBF, injectPNG, ACTIONABLE, LayerObject,
} from "./siml-engine";

function inferType(text: string): string {
  const t = text.trim();
  if (/^[+()\d][\d\s\-().]{6,}$/.test(t) && (t.match(/\d/g) || []).length >= 7) return "phone";
  if (/^(https?:\/\/|www\.)\S+$/i.test(t)) return "url";
  if (/^\S+@\S+\.\S+$/.test(t)) return "email";
  return "text";
}

export function App() {
  const [t1, setT1] = useState(true);
  const [t2, setT2] = useState(true);
  const [registry, setRegistry] = useState("http://localhost:3000/api/registry");
  const [log, setLog] = useState<string[]>(["Open a design with text, then press Export."]);
  const [busy, setBusy] = useState(false);
  const say = (m: string) => setLog((l) => [...l, m]);

  async function readLayer(): Promise<{ layer: LayerObject[]; pageW: number; pageH: number } | null> {
    let result: { layer: LayerObject[]; pageW: number; pageH: number } | null = null;
    await openDesign({ type: "current_page" }, async (session) => {
      const page = session.page as {
        type?: string;
        dimensions?: { width: number; height: number };
        elements: Iterable<{ type: string; top: number; left: number; width: number; height: number; text?: { readPlaintext(): string } }>;
      };
      if (page.type && page.type !== "absolute") return; // unsupported page kind
      const els = Array.from(page.elements);
      // Page dimensions when exposed; else the union of element extents.
      let pageW = page.dimensions?.width ?? 0;
      let pageH = page.dimensions?.height ?? 0;
      if (!pageW || !pageH) {
        for (const e of els) {
          pageW = Math.max(pageW, e.left + e.width);
          pageH = Math.max(pageH, e.top + e.height);
        }
      }
      if (!pageW || !pageH) return;

      let sawPrimary = false;
      const layer: LayerObject[] = [];
      let i = 0;
      for (const e of els) {
        if (e.type !== "text" || !e.text) continue;
        const text = e.text.readPlaintext().trim();
        if (!text) continue;
        const type = inferType(text);
        const primary = !sawPrimary && type === "phone" ? (sawPrimary = true) : false;
        layer.push({
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
      layer.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
      result = { layer, pageW, pageH };
    });
    return result;
  }

  async function run() {
    setBusy(true);
    setLog([]);
    try {
      say("Reading text elements from the design...");
      const read = await readLayer();
      if (!read) { say("Could not read this page (unsupported page type)."); return; }
      say(`Found ${read.layer.length} text element(s).`);

      say("Requesting PNG export (complete the export dialog)...");
      const exp = await requestExport({ acceptedFileTypes: ["png"] });
      if (exp.status !== "completed") { say("Export cancelled."); return; }
      const blob = await (await fetch(exp.exportBlobs[0].url)).blob();

      // Canonical grid: width 1024, height rounded to the 8-pixel block grid.
      const bmp = await createImageBitmap(blob);
      const W = 1024;
      const H = Math.max(8, Math.round(((bmp.height / bmp.width) * W) / 8) * 8);
      const canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bmp, 0, 0, W, H);
      const img = ctx.getImageData(0, 0, W, H);

      const contentId = "siml-" + Date.now().toString(36);

      let t1Mode: string | null = null;
      if (t1) {
        const sel = selectT1Payload(read.layer, contentId);
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
      const textLayer = read.layer.map((o) => ({
        ...o,
        primary: o.primary || undefined,
        runs: [{ bounds: o.bounds, text: o.text }],
        selectable: true,
        label: null,
      }));
      const payload = {
        siml: "0.3", contentId, pixelDigest,
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

      const outBlob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), "image/png"));
      const finalBytes = injectPNG(new Uint8Array(await outBlob.arrayBuffer()), serializeJUMBF(payload));
      const url = URL.createObjectURL(new Blob([finalBytes], { type: "image/png" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "design.siml.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      say(`Done. Written tiers: T0${t1Mode ? ` + T1 (${t1Mode})` : ""}${t2 ? " + T2" : ""}`);
    } catch (err) {
      say("Failed: " + (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Rows spacing="2u">
      <Title size="small">Export with SIML</Title>
      <Text size="small">
        Exports this design as a PNG whose text stays selectable, copyable, and
        machine-readable, surviving re-compression and messaging apps. The first
        phone number found is carried in an invisible pixel watermark.
      </Text>
      <Checkbox checked={t1} onChange={(_, v) => setT1(v)} label="T1 pixel watermark (offline recovery; imperceptible pixel change)" />
      <Checkbox checked={t2} onChange={(_, v) => setT2(v)} label="T2 registry fingerprint (screenshot-grade recovery; needs the registry)" />
      <FormField
        label="Registry URL"
        value={registry}
        control={(props) => <TextInput {...props} onChange={setRegistry} />}
      />
      <Button variant="primary" onClick={run} loading={busy} stretch>
        Export with SIML
      </Button>
      <Text size="xsmall" tone="tertiary">{log.join("\n")}</Text>
    </Rows>
  );
}
