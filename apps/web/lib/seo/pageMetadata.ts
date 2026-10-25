import type { Metadata } from "next";
import { absoluteUrl } from "./absoluteUrl";
import { trimDescription } from "./trimDescription";

export function pageMetadata({ title, description: raw, canonical: input, shareTitle = `${title} · SC2 Tools`, routeOgImage = false }: {
  title: string; description: string; canonical: string; shareTitle?: string; routeOgImage?: boolean;
}): Metadata {
  const canonical = input.split(/[?#]/, 1)[0], description = trimDescription(raw, 300);
  const url = absoluteUrl(canonical);
  return {
    title, description, alternates: { canonical },
    openGraph: { type: "website", siteName: "SC2 Tools", title: shareTitle, description, url,
      ...(routeOgImage ? {} : { images: [{ url: "/og.jpg", width: 1200, height: 630, alt: shareTitle }] }) },
    twitter: { card: "summary_large_image", title: shareTitle, description,
      ...(routeOgImage ? {} : { images: ["/og.jpg"] }) },
  };
}
