import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Viewer - recover text from any SIML image",
  description:
    "Drop an image and watch the resolution pipeline recover its text layer: " +
    "container, pixel watermark, checksum-verified OCR, and fingerprint registry, " +
    "with a strip-and-recompress simulator to test survival.",
  alternates: { canonical: "/view" },
};

export default function ViewLayout({ children }: { children: React.ReactNode }) {
  return children;
}
