/**
 * SEO plumbing shared by every /guides page: Next `Metadata` objects
 * (canonical without query params, Open Graph, Twitter, robots) and the
 * schema.org JSON-LD blocks (BreadcrumbList on every page, Article on
 * published build guides, VideoObject for each embedded video).
 *
 * Pure: the only input besides the payload is NEXT_PUBLIC_SITE_URL, read
 * at call time so tests can stub it. JSON-LD URLs are absolute because
 * `metadataBase` does not apply inside structured data.
 */
import type { Metadata } from "next";
import { safeVideoUrls } from "@/components/guides/youtubeUrls";
import type { GuideBuildPublished, GuideVideo } from "@/lib/guides/types";

export const GUIDE_SITE_NAME = "SC2 Tools";
const DEFAULT_SITE_URL = "https://sc2tools.com";
const SCHEMA_CONTEXT = "https://schema.org";
/** Search snippets are truncated around here; keep descriptions below it. */
const DESCRIPTION_MAX_CHARS = 300;
const OG_IMAGE = { url: "/og.jpg", width: 1200, height: 630 } as const;

/** One breadcrumb (site-relative path). */
export interface GuideCrumb {
  name: string;
  path: string;
}

/** The deployment's public origin, without a trailing slash. */
export function guideSiteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL ?? DEFAULT_SITE_URL;
  return raw.replace(/\/+$/, "");
}

/**
 * Absolute URL for a site path.
 *
 * Example: `guideAbsoluteUrl("/guides/pvz")` → "https://sc2tools.com/guides/pvz".
 */
export function guideAbsoluteUrl(path: string): string {
  return `${guideSiteUrl()}${path}`;
}

function clampDescription(text: string): string {
  if (text.length <= DESCRIPTION_MAX_CHARS) return text;
  const cut = text.slice(0, DESCRIPTION_MAX_CHARS - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : cut.length)}…`;
}

export interface GuideMetadataInput {
  title: string;
  description: string;
  /** Site path without any query string. */
  canonical: string;
  /** True for "not enough games yet" / unavailable states. */
  noindex?: boolean;
  ogType?: "website" | "article";
}

/**
 * Full page metadata for a guide surface.
 *
 * Example: `guideMetadata({ title, description, canonical: "/guides/pvz" })`
 * → `{ title, description, alternates: { canonical: "/guides/pvz" }, openGraph, twitter }`.
 */
export function guideMetadata(input: GuideMetadataInput): Metadata {
  const description = clampDescription(input.description);
  const canonical = input.canonical.split("?")[0];
  const metadata: Metadata = {
    title: input.title,
    description,
    alternates: { canonical },
    openGraph: {
      type: input.ogType ?? "website",
      siteName: GUIDE_SITE_NAME,
      title: input.title,
      description,
      url: guideAbsoluteUrl(canonical),
      images: [{ ...OG_IMAGE, alt: input.title }],
    },
    // A page-level `twitter` object replaces the root one wholesale, so
    // the card image is restated here.
    twitter: { card: "summary_large_image", title: input.title, description, images: [OG_IMAGE.url] },
  };
  if (input.noindex) metadata.robots = { index: false, follow: true };
  return metadata;
}

/**
 * Metadata for the "temporarily unavailable" state (API down): noindex
 * and nofollow so an outage never replaces real pages in the index.
 */
export function guideUnavailableMetadata(canonical: string, title: string): Metadata {
  return {
    title: `${title} | ${GUIDE_SITE_NAME}`,
    description: "This build guide is temporarily unavailable. Try again in a moment.",
    robots: { index: false, follow: false },
    alternates: { canonical: canonical.split("?")[0] },
  };
}

/**
 * schema.org BreadcrumbList with absolute URLs.
 *
 * Example: `breadcrumbJsonLd([{ name: "Guides", path: "/guides" }])`.
 */
export function breadcrumbJsonLd(crumbs: ReadonlyArray<GuideCrumb>): Record<string, unknown> {
  return {
    "@context": SCHEMA_CONTEXT,
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: guideAbsoluteUrl(crumb.path),
    })),
  };
}

function organization(): Record<string, unknown> {
  return {
    "@type": "Organization",
    name: GUIDE_SITE_NAME,
    url: guideSiteUrl(),
    logo: guideAbsoluteUrl("/logo.png"),
  };
}

/**
 * schema.org Article for a published build guide. Dates come from the
 * payload: first publication (or the stats run) and the latest run.
 */
export function buildArticleJsonLd(
  payload: GuideBuildPublished,
  path: string,
  headline: string,
  description: string,
): Record<string, unknown> {
  const modified = payload.computedAt ?? payload.firstPublishedAt;
  return {
    "@context": SCHEMA_CONTEXT,
    "@type": "Article",
    headline,
    description: clampDescription(description),
    mainEntityOfPage: guideAbsoluteUrl(path),
    datePublished: payload.firstPublishedAt ?? payload.computedAt ?? undefined,
    dateModified: modified ?? undefined,
    author: organization(),
    publisher: organization(),
    image: guideAbsoluteUrl(OG_IMAGE.url),
  };
}

/**
 * schema.org VideoObject for an embedded channel video, or null when its
 * URLs are not the first-party YouTube shapes the page would render (the
 * structured data never describes a player the page refuses to show).
 */
export function videoJsonLd(video: GuideVideo): Record<string, unknown> | null {
  const urls = safeVideoUrls(video);
  if (!urls.embed || !urls.watch || !urls.thumb) return null;
  return {
    "@context": SCHEMA_CONTEXT,
    "@type": "VideoObject",
    name: video.title,
    description: video.excerpt ?? video.title,
    thumbnailUrl: [urls.thumb],
    uploadDate: video.publishedAt,
    embedUrl: urls.embed,
    contentUrl: urls.watch,
  };
}

/**
 * JSON-LD for the one video a build / counter page embeds (the first).
 *
 * Example: `embeddedVideoJsonLd([])` → [].
 */
export function embeddedVideoJsonLd(videos: ReadonlyArray<GuideVideo>): Array<Record<string, unknown>> {
  const [first] = videos;
  const item = first ? videoJsonLd(first) : null;
  return item ? [item] : [];
}
