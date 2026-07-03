import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Editor - create images with selectable text",
  description:
    "Place text on an image and export it with a SIML layer: a JUMBF container, " +
    "an invisible pixel watermark, and a perceptual-hash registry entry, so the " +
    "text survives compression and stays selectable.",
  alternates: { canonical: "/create" },
};

export default function CreateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
