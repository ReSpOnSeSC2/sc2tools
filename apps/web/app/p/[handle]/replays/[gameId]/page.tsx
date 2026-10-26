import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { readPublicReplayIdentity } from "@/lib/publicReplayIdentity";
import { parseArchiveFrom, sharedAnalysisHref } from "@/components/public-profile/archiveQuery";
export const dynamic = "force-dynamic";
export const revalidate = 0;
type Props = { params: Promise<{ handle: string; gameId: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle, gameId } = await params;
  const { data } = await readPublicReplayIdentity(handle);
  if (!data?.profile) notFound();
  return { title: "Shared replay analysis", robots: { index: false, follow: false }, alternates: { canonical: `/players/${encodeURIComponent(data.profile.handle)}/replays/${encodeURIComponent(gameId)}` } };
}
export default async function LegacyReplay({ params, searchParams }: Props) {
  const { handle, gameId } = await params;
  const { data } = await readPublicReplayIdentity(handle);
  if (!data?.profile) notFound();
  const query = await searchParams;
  const rawFrom = Array.isArray(query?.from) ? query.from[0] : query?.from;
  permanentRedirect(sharedAnalysisHref(`/players/${encodeURIComponent(data.profile.handle)}/replays`, gameId, parseArchiveFrom(rawFrom)));
}
