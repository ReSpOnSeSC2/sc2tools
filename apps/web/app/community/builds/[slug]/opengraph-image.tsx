import { readPublicOg } from "@/components/guides/og/readPublicOg";
import type { CommunityBuildDetail } from "@/components/community/types";
import { communityBuildOg } from "@/components/guides/og/publicOgData";
import { renderPublicOgImage, PUBLIC_OG_SIZE, PUBLIC_OG_CONTENT_TYPE } from "@/components/guides/og/PublicOgCard";

export const alt = "SC2 Tools community build";
export const size = PUBLIC_OG_SIZE;
export const contentType = PUBLIC_OG_CONTENT_TYPE;
export default async function CommunityBuildOpenGraph({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await readPublicOg<CommunityBuildDetail>(`/v1/community/builds/${encodeURIComponent(slug)}`);
  return renderPublicOgImage(data ? communityBuildOg(data) : null);
}
