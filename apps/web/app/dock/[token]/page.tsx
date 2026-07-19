import { DockClient } from "@/components/dock/DockClient";

export const metadata = {
  title: "Stream Dock",
  robots: { index: false, follow: false },
};

/**
 * Force per-request rendering so OBS / proxies can't hold an old
 * build's HTML in cache and starve the dock of a fresh boot — same
 * contract as the overlay widget page (see
 * app/overlay/[token]/widget/[name]/page.tsx).
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;
// Pin fetch-cache off so a future server-component data load can't
// silently regress into the full-route cache.
export const fetchCache = "force-no-store";

export default async function DockPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <DockClient token={token} />;
}
