import { renderPlayerImage } from "@/components/public-profile/PlayerImage";
export const alt = "SC2 Tools public player page";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export default async function LegacyAuthorOg({ params }: { params: Promise<{ userId: string }> }) {
  return renderPlayerImage((await params).userId, { style: "record", theme: "dark", height: 160, large: true });
}
