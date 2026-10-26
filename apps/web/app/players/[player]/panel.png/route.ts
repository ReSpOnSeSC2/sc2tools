import { playerImageOptions, renderPlayerImage } from "@/components/public-profile/PlayerImage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function GET(request: Request, { params }: { params: Promise<{ player: string }> }) {
  const { player } = await params;
  return renderPlayerImage(player, playerImageOptions(new URL(request.url).searchParams));
}
