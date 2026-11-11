import { renderPublicOgImage, PUBLIC_OG_CONTENT_TYPE, PUBLIC_OG_SIZE } from "@/components/guides/og/PublicOgCard";
import { getInstantImportMode } from "@/lib/instant/flag";

export const alt = "Your 2026 in StarCraft II";
export const size = PUBLIC_OG_SIZE;
export const contentType = PUBLIC_OG_CONTENT_TYPE;

export default function YearRecapOpenGraph() {
  return renderPublicOgImage(getInstantImportMode() === "all" ? {
    kind: "Year in review",
    title: alt,
    subtitle: "Make a recap from your ladder replays. Your files stay on this device.",
    badge: "No account",
    stats: [],
    steps: [],
  } : null);
}
