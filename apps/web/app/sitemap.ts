import type { MetadataRoute } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://sc2tools.com";

type Route = {
  path: string;
  priority: number;
  changeFrequency: NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>;
};

// Public, indexable routes only. Auth/token-gated routes (/app, /devices,
// /streaming, /overlay, /admin, /settings, /welcome) are intentionally
// excluded — crawlers just get bounced to sign-in there.
const ROUTES: Route[] = [
  { path: "/", priority: 1.0, changeFrequency: "weekly" },
  { path: "/download", priority: 0.9, changeFrequency: "weekly" },
  { path: "/community", priority: 0.8, changeFrequency: "daily" },
  { path: "/builds", priority: 0.7, changeFrequency: "daily" },
  { path: "/optimizer", priority: 0.6, changeFrequency: "monthly" },
  { path: "/definitions", priority: 0.5, changeFrequency: "monthly" },
  { path: "/donate", priority: 0.4, changeFrequency: "monthly" },
  { path: "/legal/privacy", priority: 0.2, changeFrequency: "yearly" },
  { path: "/legal/terms", priority: 0.2, changeFrequency: "yearly" },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return ROUTES.map((route) => ({
    url: `${SITE_URL}${route.path}`,
    lastModified,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
