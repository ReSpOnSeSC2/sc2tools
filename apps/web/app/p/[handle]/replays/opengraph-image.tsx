import ReplayOg from "@/app/players/[player]/replays/opengraph-image";
export const alt = "Shared StarCraft II replay archive on SC2 Tools";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export default async function LegacyArchiveOg({ params }: { params: Promise<{ handle: string }> }) {
  return ReplayOg({ params: Promise.resolve({ player: (await params).handle }) });
}
