import { notFound, permanentRedirect } from "next/navigation";
import { publicPlayerPath, resolvePublicPlayer } from "@/lib/publicPlayer";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function generateMetadata({ params }: { params: Promise<{ userId: string }> }) {
  const { data } = await resolvePublicPlayer((await params).userId);
  if (!data?.profile) notFound();
  return { title: "Player profile", robots: { index: false, follow: false }, alternates: { canonical: publicPlayerPath(data.handle) } };
}
export default async function LegacyAuthor({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const { data } = await resolvePublicPlayer(userId);
  if (!data?.profile) notFound();
  permanentRedirect(publicPlayerPath(data.handle));
}
