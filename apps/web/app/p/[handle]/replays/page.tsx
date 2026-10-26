import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { readPublicReplayIdentity } from "@/lib/publicReplayIdentity";
export const dynamic = "force-dynamic";
export const revalidate = 0;
type Props = { params: Promise<{ handle: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { data } = await readPublicReplayIdentity((await params).handle);
  if (!data?.profile) notFound();
  return { title: `${data.profile.displayName}'s replays`, robots: { index: false, follow: false }, alternates: { canonical: `/players/${encodeURIComponent(data.profile.handle)}/replays` } };
}
export default async function LegacyReplays({ params, searchParams }: Props) {
  const [{ handle }, query] = await Promise.all([params, searchParams]);
  const { data } = await readPublicReplayIdentity(handle);
  if (!data?.profile) notFound();
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) for (const item of Array.isArray(value) ? value : typeof value === "string" ? [value] : []) search.append(key, item);
  permanentRedirect(`/players/${encodeURIComponent(data.profile.handle)}/replays${search.size ? `?${search}` : ""}`);
}
