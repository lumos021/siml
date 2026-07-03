import type { MetadataRoute } from "next";
import { SITE_URL } from "./site";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE_URL, lastModified: new Date(), changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/create`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE_URL}/view`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.8 },
  ];
}
