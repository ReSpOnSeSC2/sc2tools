const DEFAULT_SITE = "https://sc2tools.com";

/** Stable public origin for metadata and JSON-LD; never uses request headers. */
export function siteOrigin(): string {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SITE_URL || DEFAULT_SITE);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.origin : DEFAULT_SITE;
  } catch { return DEFAULT_SITE; }
}

export function absoluteUrl(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u001f]/.test(path)) throw new Error("A site-relative URL is required");
  const origin = siteOrigin(), url = new URL(path, origin);
  if (url.origin !== origin) throw new Error("A same-origin URL is required");
  return url.href;
}
