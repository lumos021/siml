import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { SITE_URL, SITE_NAME, SITE_DESCRIPTION } from "./site";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "SIML - Selectable text layers for images",
    template: "%s | SIML",
  },
  description: SITE_DESCRIPTION,
  keywords: [
    "selectable text in images", "copy text from image", "image text layer",
    "OCR alternative", "image metadata", "JUMBF", "C2PA", "watermark",
    "perceptual hash", "accessibility", "machine-readable images",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: SITE_NAME,
    title: "SIML - Selectable text layers for images",
    description:
      "A phone number in a JPEG is just pixels. SIML keeps it text - selectable, " +
      "copyable, and verified exact, surviving compression and messaging apps. CC0 open spec.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "SIML - selectable text layers for images" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "SIML - Selectable text layers for images",
    description:
      "Like a PDF text layer, but for raster images - hardened to survive real-world distribution. CC0.",
    images: ["/og.png"],
  },
  robots: { index: true, follow: true },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "SIML",
  alternateName: "Selectable Image Markup Language",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Web",
  description: SITE_DESCRIPTION,
  url: SITE_URL,
  license: "https://creativecommons.org/publicdomain/zero/1.0/",
  sameAs: ["https://github.com/lumos021/siml"],
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Montserrat:wght@400;500;600;700&family=Roboto:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body className="antialiased">
        <nav className="nav">
          <div className="nav-inner">
            <a href="/" className="nav-brand">
              <span className="nav-logo">◈</span> SIML
            </a>
            <div className="nav-links">
              <a href="/create" className="nav-link">Create</a>
              <a href="/view" className="nav-link">View</a>
            </div>
          </div>
        </nav>
        <main>{children}</main>
        <Analytics />
      </body>
    </html>
  );
}
