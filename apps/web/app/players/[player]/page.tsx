import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { PublicPlayerPage } from "@/components/public-profile/PublicPlayerPage";
import { publicPlayerPath, resolvePublicPlayer } from "@/lib/publicPlayer";
import { siteTitle } from "@/lib/siteTitle";

export const dynamic = "force-dynamic";
export const revalidate = 0;
type Props = { params: Promise<{ player: string }>; searchParams?: Promise<{ tab?: string | string[] }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { player } = await params;
  const { data } = await resolvePublicPlayer(player);
  if (!data) notFound();
  const canonical = data.archiveOnly ? `${publicPlayerPath(data.handle)}/replays` : publicPlayerPath(data.handle);
  const title = data.archiveOnly ? `${data.displayName}'s replays` : `${data.displayName} · StarCraft II player`;
  const description = data.profile ? `${data.displayName}'s public record, matchup splits and shared builds on SC2 Tools.` : "Shared StarCraft II replays.";
  return { title, description, alternates: { canonical }, robots: data.archiveOnly ? { index: false, follow: false } : undefined,
    openGraph: { type: "profile", title: siteTitle(title), description, url: canonical },
    twitter: { card: "summary_large_image", title: siteTitle(title), description } };
}
export default async function PlayerPage({ params, searchParams }: Props) {
  const { player } = await params;
  const { data } = await resolvePublicPlayer(player);
  if (!data) notFound();
  if (data.archiveOnly) permanentRedirect(`${publicPlayerPath(data.handle)}/replays`);
  if (!data.profile) notFound();
  if (data.handle !== player) permanentRedirect(publicPlayerPath(data.handle));
  const query = await searchParams;
  const tab = typeof query?.tab === "string" ? query.tab : undefined;
  return <PublicPlayerPage profile={data.profile} requestedTab={tab} />;
}
