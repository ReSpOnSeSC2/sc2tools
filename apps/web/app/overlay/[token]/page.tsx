import { OverlayClient } from "@/components/OverlayClient";

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
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <OverlayClient token={token} />;
}
