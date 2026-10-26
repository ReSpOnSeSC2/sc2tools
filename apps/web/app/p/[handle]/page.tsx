import { notFound, permanentRedirect } from "next/navigation";
import { publicPlayerPath, resolvePublicPlayer } from "@/lib/publicPlayer";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }) {
  const { data } = await resolvePublicPlayer((await params).handle);
  if (!data?.profile) notFound();
  return { title: "Player profile", robots: { index: false, follow: false }, alternates: { canonical: publicPlayerPath(data.handle) } };
}
/** One hop; archive-only consent never revives an explicitly disabled profile. */
export default async function LegacyProfile({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const { data } = await resolvePublicPlayer(handle);
  if (!data?.profile) notFound();
  permanentRedirect(publicPlayerPath(data.handle));
}
