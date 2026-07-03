// Canonical site URL, environment-driven so SEO metadata upgrades itself:
// set NEXT_PUBLIC_SITE_URL when the real domain lands; until then Vercel's
// production URL is used, and localhost in dev.
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3000");

export const SITE_NAME = "SIML";
export const SITE_DESCRIPTION =
  "SIML makes the text inside images selectable, copyable, and machine-readable: " +
  "a PDF-style text layer for PNG/JPEG/WebP that survives re-encoding, messaging apps, " +
  "and screenshots. Open CC0 spec with a working editor and viewer.";
