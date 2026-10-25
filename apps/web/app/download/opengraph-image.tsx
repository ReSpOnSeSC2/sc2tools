import { marketingOg } from "@/components/guides/og/publicOgData";
import { renderPublicOgImage, PUBLIC_OG_SIZE, PUBLIC_OG_CONTENT_TYPE } from "@/components/guides/og/PublicOgCard";
export const alt = "SC2 Tools desktop app";
export const size = PUBLIC_OG_SIZE;
export const contentType = PUBLIC_OG_CONTENT_TYPE;
export default function DownloadOpenGraph() { return renderPublicOgImage(marketingOg("download")); }
