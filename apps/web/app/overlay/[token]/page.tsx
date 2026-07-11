import { OverlayClient } from "@/components/OverlayClient";
import { OVERLAY_THEME_PARAM } from "@/lib/overlayTheme";

export const metadata = {
  title: "Live overlay",
  robots: { index: false, follow: false },
};

/**
 * Force per-request rendering so Streamlabs / OBS / Cloudflare can't
 * hold an old build's HTML in cache and starve the live socket
 * subscription of a fresh boot. Mirrors the per-widget route's
 * cache-bypass exports.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export default async function OverlayPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  // Optional ``?theme=`` styling param (see lib/overlayTheme.ts).
  // Passed through raw — the client decodes it with strict validation
  // and silently falls back to the stock look on any malformed value.
  const sp = await searchParams;
  const themeParam = typeof sp[OVERLAY_THEME_PARAM] === "string"
    ? (sp[OVERLAY_THEME_PARAM] as string)
    : null;
  return <OverlayClient token={token} themeParam={themeParam} />;
}
