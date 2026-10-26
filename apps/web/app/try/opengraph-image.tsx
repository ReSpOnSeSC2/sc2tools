import { getInstantImportMode } from "@/lib/instant/flag";
import { marketingOg } from "@/components/guides/og/publicOgData";
import { renderPublicOgImage, PUBLIC_OG_SIZE, PUBLIC_OG_CONTENT_TYPE } from "@/components/guides/og/PublicOgCard";
export const alt = "Free SC2 replay analyzer";
export const size = PUBLIC_OG_SIZE;
export const contentType = PUBLIC_OG_CONTENT_TYPE;
export default function TryOpenGraph() { return renderPublicOgImage(getInstantImportMode() === "all" ? marketingOg("try") : null); }
