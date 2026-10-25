import { readPublicOg } from "@/components/guides/og/readPublicOg";
import type { CommunityAuthorProfile } from "@/components/community/types";
import { communityAuthorOg } from "@/components/guides/og/publicOgData";
import { renderPublicOgImage, PUBLIC_OG_SIZE, PUBLIC_OG_CONTENT_TYPE } from "@/components/guides/og/PublicOgCard";

export const alt = "SC2 Tools community author";
export const size = PUBLIC_OG_SIZE;
export const contentType = PUBLIC_OG_CONTENT_TYPE;
export default async function CommunityAuthorOpenGraph({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const data = await readPublicOg<CommunityAuthorProfile>(`/v1/community/authors/${encodeURIComponent(userId)}`);
  return renderPublicOgImage(data ? communityAuthorOg(data) : null);
}
