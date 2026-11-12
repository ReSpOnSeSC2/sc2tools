import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StreamViewer } from "@/components/public-profile/StreamViewer";
import { getJsonWithStatus } from "@/lib/serverApi";
import { PublicFetchError } from "@/lib/publicFetchError";
import { parseStreamViewer } from "@/lib/streamViewer";
import { streamViewerApiPath } from "@/lib/streamViewerRoute";
import { siteTitle } from "@/lib/siteTitle";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: siteTitle("Stream viewer"),
  description: "Delayed results from a StarCraft II stream session.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function StreamViewerRoute({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  if (handle.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{10}$/.test(handle)) notFound();
  const result = await getJsonWithStatus<unknown>(streamViewerApiPath(handle), { signal: AbortSignal.timeout(8000) });
  if (result.status === 404) notFound();
  const page = parseStreamViewer(result.data);
  if (!page) throw new PublicFetchError(result.status);
  return <article className="mx-auto w-full max-w-3xl space-y-5 px-4 py-8 sm:px-6">
    <h1 className="font-display text-h1 font-bold text-text">Stream viewer</h1>
    <StreamViewer key={handle} handle={handle} initial={page} />
  </article>;
}
