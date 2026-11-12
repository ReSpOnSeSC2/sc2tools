import type { CommunityBuildDetail } from "@/components/community/types";
import { publicReferenceBuildOrder } from "@/lib/buildOrderReference";
import { communityCacheOptions } from "@/lib/communityCache";
import { coerceRace } from "@/lib/race";
import { getJsonWithStatus } from "@/lib/serverApi";
import { practiceLinkByAlias, type PracticeLink } from "./practiceLinks";

export function practiceBuild(link: PracticeLink, data: CommunityBuildDetail) {
  if (data.slug !== link.communitySlug || data.authorName !== link.creator) return null;
  return {
    title: data.title,
    creator: data.authorName,
    order: publicReferenceBuildOrder(data.build?.buildOrder),
    race: coerceRace(data.build?.race),
  };
}

export async function loadPracticeLink(alias: string) {
  const link = practiceLinkByAlias(alias);
  if (!link) return { kind: "missing" } as const;
  const { data, status } = await getJsonWithStatus<CommunityBuildDetail>(
    `/v1/community/builds/${encodeURIComponent(link.communitySlug)}`,
    communityCacheOptions(link.communitySlug),
  );
  if (status === 404) return { kind: "missing" } as const;
  if (!data) return { kind: "unavailable", link } as const;
  const build = practiceBuild(link, data);
  return build ? { kind: "ready", link, build } as const : { kind: "missing" } as const;
}
