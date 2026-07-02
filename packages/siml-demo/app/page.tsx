"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import s from "./home.module.css";

export default function HomePage() {
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);

  function showToast(msg: string, type: "success" | "error" = "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  return (
    <div className={s.page}>
      <Hero />
      <Problem />
      <VsSection showToast={showToast} />
      <Survival />
      <ActionSafety />
      <Developers />
      <Paths />
      <HowItWorks />
      <FootBand />

      {toast && (
        <div style={{
          position: "fixed",
          bottom: "1.5rem",
          right: "1.5rem",
          zIndex: 100,
          padding: "0.75rem 1.25rem",
          borderRadius: "8px",
          fontSize: "0.875rem",
          fontWeight: 500,
          background: toast.type === "success" ? "rgba(45, 212, 168, 0.15)" : "rgba(248, 113, 113, 0.15)",
          color: toast.type === "success" ? "var(--good)" : "var(--no)",
          border: toast.type === "success" ? "1px solid rgba(45, 212, 168, 0.3)" : "1px solid rgba(248, 113, 113, 0.3)",
          boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
          transition: "all 0.3s ease"
        }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

/* ── Hero with the selection-reveal animation ─────────────────────────── */
function Hero() {
  const selRef = useRef<HTMLSpanElement>(null);
  const [revealed, setRevealed] = useState(false);

  const sweep = useCallback(() => {
    const reduce = typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion:reduce)").matches;
    const el = selRef.current;
    if (reduce) { setRevealed(true); return; }
    setRevealed(false);
    if (el) {
      el.style.transition = "none";
      el.style.width = "0";
      requestAnimationFrame(() => {
        el.style.transition = "width 1.1s cubic-bezier(.6,0,.2,1)";
        el.style.width = "calc(100% + 12px)";
      });
    }
    window.setTimeout(() => setRevealed(true), 900);
  }, []);

  useEffect(() => {
    const t = window.setTimeout(sweep, 600);
    const iv = window.setInterval(sweep, 5200);
    return () => { window.clearTimeout(t); window.clearInterval(iv); };
  }, [sweep]);

  return (
    <header className={s.header}>
      <div className={`${s.wrap} ${s.heroGrid}`}>
        <div>
          <span className={s.eyebrow}>Selectable Image Markup Language</span>
          <h1 className={s.h1}>
            A phone number in a JPEG is just&nbsp;pixels.<br />SIML keeps it text.
          </h1>
          <p className={s.lead}>
            Carry real, selectable, typed text inside an ordinary image, and keep it through
            the compression that strips every other kind of metadata.
          </p>
          <div className={s.ctas}>
            <Link className={`${s.btn} ${s.btnPrimary}`} href="/view">Try the live demo →</Link>
            <Link className={`${s.btn} ${s.btnGhost}`} href="/create">Open the editor</Link>
          </div>
        </div>

        <div className={s.demoCard} aria-hidden="true">
          <div 
            className={s.banner} 
            onClick={sweep}
            style={{
              backgroundImage: "url('/hero_banner_base.png')",
              backgroundSize: "cover",
              backgroundPosition: "center"
            }}
          >
            <span className={s.bEyebrow}>ACME DESIGN STUDIO</span>
            <span className={s.bTitle}>Creative Designs &amp; Graphics</span>
            <span className={s.bPhone}>
              Call: +91 98765 43210
              <span className={s.sel} ref={selRef} />
            </span>
          </div>
          <div className={s.revealRow}>
            <span className={s.revealLbl}>recovered:</span>
            <span className={`${s.revealVal} ${revealed ? s.revealValOn : ""}`}>+91 98765 43210</span>
            <span className={s.revealTag}>{revealed ? "type: phone" : ""}</span>
          </div>
          <div className={s.demoHint}>↑ the text isn&apos;t drawn on top; it&apos;s <em>inside</em> the image</div>
        </div>
      </div>
    </header>
  );
}

/* ── Why / isn't this already solved ──────────────────────────────────── */
function Problem() {
  return (
    <section id="problem" className={s.section}>
      <div className={s.wrap}>
        <div className={s.secHead}>
          <span className={s.eyebrow}>Isn&apos;t this already solved?</span>
          <h2>Pieces of it exist. None of them keep authored text alive in a raster.</h2>
          <p>The honest comparison, because that&apos;s the first question every engineer asks.</p>
        </div>
        <table className={s.cmp}>
          <thead>
            <tr>
              <th>Approach</th>
              <th>Exact text (not a guess)</th>
              <th>Typed actions</th>
              <th>Survives re-encode</th>
              <th className={s.simlCol}>SIML</th>
            </tr>
          </thead>
          <tbody>
            <tr><td className={s.rowH}>OCR / Live Text / Lens</td><td><span className={s.nope}>✗ inferred</span></td><td><span className={s.partial}>~ some</span></td><td><span className={s.yes}>✓ re-reads</span></td><td className={s.simlCol} /></tr>
            <tr><td className={s.rowH}>EXIF / IPTC metadata</td><td><span className={s.yes}>✓</span></td><td><span className={s.nope}>✗</span></td><td><span className={s.nope}>✗ stripped</span></td><td className={s.simlCol} /></tr>
            <tr><td className={s.rowH}>C2PA Content Credentials</td><td><span className={s.yes}>✓</span></td><td><span className={s.nope}>✗ provenance</span></td><td><span className={s.nope}>✗ stripped</span></td><td className={s.simlCol} /></tr>
            <tr><td className={s.rowH}>alt / aria-label</td><td><span className={s.yes}>✓</span></td><td><span className={s.nope}>✗</span></td><td><span className={s.nope}>✗ not in file</span></td><td className={s.simlCol} /></tr>
            <tr><td className={s.rowH}><b>SIML</b></td><td className={s.simlCol}><span className={s.yes}>✓ authored</span></td><td className={s.simlCol}><span className={s.yes}>✓ phone/url/…</span></td><td className={s.simlCol}><span className={s.yes}>✓ + recovery</span></td><td className={s.simlCol} /></tr>
          </tbody>
        </table>
        <p className={s.note}>SIML rides inside JUMBF, the same container as C2PA, so it&apos;s complementary, not competing.</p>
      </div>
    </section>
  );
}

/* ── Survival round-trip stepper ──────────────────────────────────────── */
const SURVIVE_STEPS = [
  { kind: "", n: "1", title: "Author the image", sub: "phone embedded · container + pixel watermark", recovered: false },
  { kind: "", n: "2", title: "Platform re-compresses", sub: "JPEG q40 · a normal CDN / chat transcode", recovered: false },
  { kind: "fail", n: "✕", title: "Metadata stripped", sub: "EXIF · XMP · C2PA container: all gone", recovered: false },
  { kind: "win", n: "✓", title: "Watermark recovers it", sub: "+91 98765 43210 · CRC verified", recovered: true },
];

function Survival() {
  const [active, setActive] = useState(-1);
  const [running, setRunning] = useState(false);
  const stepperRef = useRef<HTMLDivElement>(null);
  const ranOnce = useRef(false);

  const run = useCallback(() => {
    if (running) return;
    setRunning(true);
    setActive(-1);
    let i = 0;
    const tick = () => {
      setActive(i);
      i++;
      if (i < SURVIVE_STEPS.length) window.setTimeout(tick, 760);
      else window.setTimeout(() => setRunning(false), 760);
    };
    tick();
  }, [running]);

  useEffect(() => {
    if (!stepperRef.current) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting && !ranOnce.current) { ranOnce.current = true; run(); io.disconnect(); }
      });
    }, { threshold: 0.5 });
    io.observe(stepperRef.current);
    return () => io.disconnect();
  }, [run]);

  return (
    <section id="survive" className={s.section}>
      <div className={s.wrap}>
        <div className={s.survive}>
          <div>
            <span className={`${s.eyebrow} ${s.surviveEyebrow}`}>The part nobody else does</span>
            <h2>It survives the re-encode that kills metadata.</h2>
            <p>
              Re-compress an image and EXIF, XMP, C2PA (every metadata layer) is gone. SIML can
              put the critical text <em>in the pixels</em>, recoverable offline, with an integrity
              check so a bad read fails loudly instead of returning a wrong number.
            </p>
            <button className={`${s.btn} ${s.btnPrimary}`} style={{ marginTop: 8 }} onClick={run}>
              {running ? "Running…" : active >= 0 ? "Run again ▶" : "Run the round-trip ▶"}
            </button>
          </div>
          <div className={s.stepper} ref={stepperRef}>
            {SURVIVE_STEPS.map((st, i) => (
              <div
                key={i}
                className={[s.step, active >= i ? s.stepOn : "", st.kind === "fail" ? s.stepFail : "", st.kind === "win" ? s.stepWin : ""].filter(Boolean).join(" ")}
              >
                <div className={s.dot}>{st.n}</div>
                <div>
                  <div className={s.sTitle}>{st.title}</div>
                  <div className={`${s.sSub} ${st.recovered ? s.sSubRecovered : ""}`}>{st.sub}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className={s.cap}>
          <h3>What survives what, stated plainly</h3>
          <p className={s.capSub}>Measured, not marketing. We show the limits on purpose.</p>
          <div className={s.capGrid}>
            <div className={s.capItem}><span className={`${s.capIc} ${s.capIcY}`}>✓</span><span className={s.capCt}><b>Email, CDN, direct file</b><span>Container carries the full layer, lossless</span></span></div>
            <div className={s.capItem}><span className={`${s.capIc} ${s.capIcY}`}>✓</span><span className={s.capCt}><b>Re-compression &amp; moderate downscale</b><span>Pixel watermark, fully offline</span></span></div>
            <div className={s.capItem}><span className={`${s.capIc} ${s.capIcP}`}>~</span><span className={s.capCt}><b>Aggressive downscale, screenshots</b><span>Recovered via the fingerprint registry (online)</span></span></div>
            <div className={s.capItem}><span className={`${s.capIc} ${s.capIcN}`}>✗</span><span className={s.capCt}><b>Heavy crop / rotation</b><span>Falls back to OCR + the visible text</span></span></div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── Action control & anti-cloaking (spec §8.1 / §9.2) ────────────────── */
const SAFE_CARDS = [
  { icon: "✍️", title: "Authors declare meaning, not behavior", desc: "The creator marks what a string is (phone/url/email/address) and whether they'd like it actioned (intent: actionable / read-only / auto). They can't force your device to dial or open anything." },
  { icon: "🧭", title: "The platform stays in control", desc: "Your browser or OS decides whether to offer the action (dial, show a menu, copy only, or nothing) within the author's permission limits. SIML never seizes that UX." },
  { icon: "🛡️", title: "Reveal before act, always", desc: "Any enabled action MUST show you the literal target (“Open siml-spec.org?”) and wait for your OK. No silent auto-dial. Unsafe schemes (javascript:, data:, file:) are refused outright." },
];

function ActionSafety() {
  return (
    <section id="safety" className={s.section}>
      <div className={s.wrap}>
        <div className={s.secHead}>
          <span className={s.eyebrow}>Actions you can trust</span>
          <h2>A hidden layer could say something different from the picture. SIML closes that gap.</h2>
          <p>Who decides what happens on a tap is defined, and the real target is always shown first.</p>
        </div>
        <div className={s.safeGrid}>
          {SAFE_CARDS.map((c, i) => (
            <div key={i} className={s.safeCard}>
              <div className={s.safeIcon}>{c.icon}</div>
              <h3>{c.title}</h3>
              <p>{c.desc}</p>
            </div>
          ))}
        </div>
        <div className={s.authority}>
          Order of authority: <b>permissions</b> (hard limit, MUST) → <b>platform choice</b> → <b>intent</b> (soft request, SHOULD).
          Enabling an action and the reveal-before-act safeguard are one indivisible obligation.
        </div>
      </div>
    </section>
  );
}

/* ── Developers ───────────────────────────────────────────────────────── */
function Developers() {
  return (
    <section id="dev" className={s.section}>
      <div className={s.wrap}>
        <div className={s.devGrid}>
          <div>
            <span className={s.eyebrow}>For developers</span>
            <h2 style={{ fontSize: "clamp(26px,3.4vw,38px)", marginTop: 12 }}>
              Two packages: write the layer, read it back.
            </h2>
            <p style={{ color: "var(--mute)", margin: "16px 0 0" }}>
              The writer embeds T0/T1/T2 into ordinary PNG/JPEG/WebP; the reader parses it in the
              browser and renders selectable text. Coordinates are percentages, so the layer
              survives resize and format conversion.
            </p>
            <div className={s.ctas} style={{ marginTop: 24 }}>
              <Link className={`${s.btn} ${s.btnPrimary}`} href="/create">Open the editor</Link>
              <Link className={`${s.btn} ${s.btnGhost}`} href="/view">Open the viewer</Link>
            </div>
          </div>
          <div>
            <pre className={s.pre}>
{``}<span className={s.cmt}>{`// write side: siml-writer (Node)`}</span>{`
`}<span className={s.kw}>const</span>{` { write } = `}<span className={s.kw}>require</span>{`(`}<span className={s.str}>{`'siml-writer'`}</span>{`);
`}<span className={s.kw}>await</span>{` `}<span className={s.fn}>write</span>{`({ imagePath, definition, outputPath,
  embedWatermark: `}<span className={s.kw}>true</span>{`, registerLocal: `}<span className={s.kw}>true</span>{` });

`}<span className={s.cmt}>{`// read side: siml-reader (browser)`}</span>{`
`}<span className={s.kw}>const</span>{` r = `}<span className={s.kw}>await</span>{` `}<span className={s.fn}>extractPayload</span>{`(bytes);
`}<span className={s.cmt}>{`// → T0 layer, or T1/T2 recovery on a stripped file`}</span>
            </pre>
            <div className={s.codecap}>Round-trips across PNG / JPEG / WebP, with a size cap, CRC on the watermark, and a Hamming threshold on the fingerprint.</div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── Adoption paths ───────────────────────────────────────────────────── */
function Paths() {
  return (
    <section id="paths" className={s.section}>
      <div className={s.wrap}>
        <div className={s.secHead}>
          <span className={s.eyebrow}>Pick your level</span>
          <h2>Adopt only what fits. Declare exactly that.</h2>
          <p>Support is capability-based: a CDN never implements the renderer; a viewer never implements the encoder.</p>
        </div>
        <div className={s.paths}>
          <Link className={s.path} href="/create">
            <span className={s.pTag}>You make images</span>
            <h3>Author</h3>
            <p>Emit a SIML layer on export from your design tool or pipeline.</p>
            <div className={s.lvl}>→ Level W · Write</div>
          </Link>
          <Link className={s.path} href="/create">
            <span className={s.pTag}>You serve images</span>
            <h3>Preserve</h3>
            <p>Keep the layer through your optimization step instead of stripping it.</p>
            <div className={s.lvl}>→ Level P · Preserve</div>
          </Link>
          <Link className={s.path} href="/view">
            <span className={s.pTag}>You display images</span>
            <h3>Render</h3>
            <p>Show the raster, overlay selectable text, offer typed actions safely.</p>
            <div className={s.lvl}>→ Level R + X · Read &amp; Render</div>
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ── How it works (tiers) ─────────────────────────────────────────────── */
function HowItWorks() {
  return (
    <section id="how" className={s.section}>
      <div className={s.wrap}>
        <div className={s.secHead}>
          <span className={s.eyebrow}>How it works</span>
          <h2>Three tiers. Each covers the others&apos; blind spots.</h2>
          <p>No single mechanism survives everything, so SIML layers three, and is honest about where each one ends.</p>
        </div>
        <div className={s.tiers}>
          <div className={s.tier}>
            <span className={s.tId}>T0 · CONTAINER</span>
            <h3>In the file</h3>
            <p>The full layer (every object, position and style) as JSON in a JUMBF box.</p>
            <div className={s.tMeta}>survives: any non-re-encoding hop · <b>dies on re-encode</b></div>
          </div>
          <div className={s.tier}>
            <span className={s.tId}>T1 · WATERMARK</span>
            <h3>In the pixels</h3>
            <p>A short typed field embedded with a robust, invisible DCT watermark, fully offline.</p>
            <div className={s.tMeta}>survives: re-encode + moderate downscale · <b>fixed-step, CRC-verified</b></div>
          </div>
          <div className={s.tier}>
            <span className={s.tId}>T2 · FINGERPRINT</span>
            <h3>In the appearance</h3>
            <p>A perceptual hash resolves the full layer from a registry, even after a screenshot.</p>
            <div className={s.tMeta}>survives: aggressive downscale, screenshots · <b>needs registry</b></div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── Footer band ──────────────────────────────────────────────────────── */
function FootBand() {
  return (
    <section className={s.section} style={{ borderTop: "none" }}>
      <div className={s.wrap}>
        <div className={s.footer}>
          <div className={s.wrap}>
            <div className={s.footGrid}>
              <div>
                <div style={{ fontFamily: "var(--display)", fontWeight: 800, fontSize: 20, color: "#fff" }}>◈ SIML</div>
                <p className={s.footTag}>An open, royalty-free layer for keeping authored text alive inside images. Reading is always free and offline.</p>
                <div style={{ marginTop: 18, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <span className={s.badge}><b>CC0</b> public domain</span>
                  <span className={s.badge}>built on <b>JUMBF / C2PA</b></span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 40, flexWrap: "wrap" }}>
                <Link className={`${s.btn} ${s.btnPrimary}`} href="/create">Open editor</Link>
                <Link className={`${s.btn} ${s.btnGhost}`} href="/view" style={{ color: "#fff", borderColor: "var(--ink-line)" }}>Open viewer</Link>
              </div>
            </div>
            <div className={s.footBottom}>
              <span>The spec, reader &amp; reference encoder are CC0. You never need a paid product to read a layer.</span>
              <span>SIML · open standard</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── Dead Pixels vs Interactive Text (VS Section) ─────────────────────── */
function VsSection({ showToast }: { showToast: (msg: string, type?: "success" | "error") => void }) {
  const OVERLAYS = [
    { id: 's1', type: 'text', text: 'ACME DESIGN STUDIO - PROMO', x: 6.25, y: 11.72, w: 34.28, h: 4.39, cls: "" },
    { id: 's2', type: 'text', text: 'Creative Layouts & Graphics', x: 6.25, y: 21.48, w: 71.19, h: 8.79, cls: "" },
    { id: 's3', type: 'phone', text: '+91 98765 43210', x: 6.25, y: 44.92, w: 26.37, h: 5.86, cls: s.overlayPhone },
    { id: 's4', type: 'url', text: 'https://siml-spec.org', x: 6.25, y: 58.59, w: 31.35, h: 4.98, cls: s.overlayUrl },
    { id: 's5', type: 'address', text: '123 Demo Street, Suite 456, SF', x: 6.25, y: 71.29, w: 39.55, h: 4.39, cls: s.overlayAddress }
  ];

  // Reveal-before-act (spec §9.2): show the literal target and act only on
  // explicit confirmation. Never auto-dial or auto-open on a bare click.
  const handleOverlayClick = (e: React.MouseEvent, ov: typeof OVERLAYS[0]) => {
    e.stopPropagation();
    if (ov.type === 'phone') {
      const target = "tel:+919876543210";
      if (window.confirm(`Call this phone number?\n\n${ov.text}\nWill open: ${target}`)) {
        window.location.href = target;
      }
    } else if (ov.type === 'url') {
      const target = "https://siml-spec.org";
      if (window.confirm(`Open this link?\n\n${ov.text}\nWill open: ${target}`)) {
        window.open(target, "_blank", "noopener,noreferrer");
      }
    } else {
      navigator.clipboard.writeText(ov.text);
      showToast(`📋 Copied text: "${ov.text}"`, "success");
    }
  };

  return (
    <section id="versus" className={s.section} style={{ background: "rgba(0,0,0,0.015)" }}>
      <div className={s.wrap}>
        <div className={s.secHead} style={{ textAlign: "center", margin: "0 auto 40px" }}>
          <span className={s.eyebrow}>Live Comparison</span>
          <h2>Dead Pixels vs. Interactive Text</h2>
          <p style={{ maxWidth: "580px", margin: "16px auto 0" }}>
            Traditional images lock copy behind a wall of paint. SIML adds a transparent interaction grid that behaves like a document. <strong>Click the elements below to test the comparison.</strong>
          </p>
        </div>

        <div className={s.vsGrid}>
          {/* Left: Traditional Image */}
          <div className={s.vsCard}>
            <div style={{ position: "absolute", top: "1rem", right: "1rem", background: "rgba(194,86,106,0.12)", color: "var(--no)", border: "1px solid rgba(194,86,106,0.25)", fontSize: "0.75rem", padding: "0.25rem 0.5rem", borderRadius: "4px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: "var(--mono)", zIndex: 10 }}>
              Traditional Image
            </div>
            <h3 style={{ fontSize: "1.1rem", fontWeight: 600, color: "var(--ink)", marginBottom: "0.25rem", fontFamily: "var(--display)" }}>Flat Raster Pixels</h3>
            <p style={{ fontSize: "0.85rem", color: "var(--mute)", marginBottom: "1rem" }}>Text is baked into the image. No copy-paste, no direct action.</p>

            <div className={s.creativeWrapper} onClick={() => showToast("🔒 Locked: Traditional pixels cannot be highlighted or clicked.", "error")} style={{ cursor: "not-allowed" }}>
              <img src="/test.siml.png" className={s.creativeImage} alt="Flat traditional creative banner" />
              <div style={{ position: "absolute", inset: 0 }} />
            </div>
          </div>

          {/* Right: SIML Enhanced */}
          <div className={s.vsCard}>
            <div style={{ position: "absolute", top: "1rem", right: "1rem", background: "rgba(63,168,119,0.12)", color: "var(--good)", border: "1px solid rgba(63,168,119,0.25)", fontSize: "0.75rem", padding: "0.25rem 0.5rem", borderRadius: "4px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: "var(--mono)", zIndex: 10 }}>
              SIML Enhanced
            </div>
            <h3 style={{ fontSize: "1.1rem", fontWeight: 600, color: "var(--ink)", marginBottom: "0.25rem", fontFamily: "var(--display)" }}>Selectable Smart Layer</h3>
            <p style={{ fontSize: "0.85rem", color: "var(--mute)", marginBottom: "1rem" }}>An invisible vector layout sits on top. Users interact with text naturally.</p>

            <div className={s.creativeWrapper}>
              <img src="/test.siml.png" className={s.creativeImage} alt="SIML enhanced selectable creative banner" />
              {OVERLAYS.map(ov => (
                <div
                  key={ov.id}
                  className={`${s.overlay} ${ov.cls || ""}`}
                  style={{
                    left: `${ov.x}%`,
                    top: `${ov.y}%`,
                    width: `${ov.w}%`,
                    height: `${ov.h}%`
                  }}
                  onClick={(e) => handleOverlayClick(e, ov)}
                  title={`${ov.type}: ${ov.text}`}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
