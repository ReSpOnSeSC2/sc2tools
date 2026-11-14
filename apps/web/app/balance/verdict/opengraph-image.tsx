import { renderPublicOgImage, PUBLIC_OG_SIZE, PUBLIC_OG_CONTENT_TYPE } from "@/components/guides/og/PublicOgCard";

export const dynamic = "force-static";
export const alt = "Balance Court verdict · Data: SC2Pulse";
export const size = PUBLIC_OG_SIZE;
export const contentType = PUBLIC_OG_CONTENT_TYPE;

export default function ReplayVerdictOpenGraph() {
  return renderPublicOgImage({
    kind: "Balance Court",
    title: "A StarCraft II verdict",
    subtitle: "Replay exhibits stay with the player. Ladder evidence from SC2Pulse.",
    steps: [],
    stats: [],
  });
}
