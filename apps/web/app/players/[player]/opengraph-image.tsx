import { renderPlayerImage } from "@/components/public-profile/PlayerImage";
export const alt = "SC2 Tools public player page";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export default async function PlayerOg({ params }: { params: Promise<{ player: string }> }) {
  const { player } = await params;
  return renderPlayerImage(player, { style: "record", theme: "dark", height: 160, large: true });
}
