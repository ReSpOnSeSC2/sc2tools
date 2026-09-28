import Link from "next/link";
import { BookOpen } from "lucide-react";
import { guidePaths } from "@/components/guides/guideMetadata";
import { GUIDE_LINK_CLASS } from "@/components/guides/guideUi";
import { fetchGuideMatchup } from "@/lib/guides/api";
import { communityGuideMatchup, findCommunityGuide } from "@/lib/guides/communityGuide";
import { guidesEnabled } from "@/lib/guides/flags";

/**
 * "Read the community guide" on a community build page, pointing at the
 * canonical guide when the matchup's guide payload lists a published
 * build with exactly this name (lib/guides/communityGuide.ts). Server
 * component; renders nothing when guides are off, the matchup is not a
 * 1v1 matchup, the API is down or nothing matches exactly. The matchup
 * payload is the same cached read the guide pages use.
 */
export async function CommunityGuideLink({
  matchup,
  names,
}: {
  matchup: string | undefined;
  names: ReadonlyArray<unknown>;
}) {
  if (!guidesEnabled()) return null;
  const canonical = communityGuideMatchup(matchup);
  if (!canonical) return null;
  const slug = canonical.toLowerCase();
  const result = await fetchGuideMatchup(slug);
  if (result.kind !== "ok") return null;
  const target = findCommunityGuide(result.data, names);
  if (!target) return null;
  return (
    <p className="inline-flex items-center gap-2 text-caption text-text-muted">
      <BookOpen className="h-4 w-4 text-accent-cyan" aria-hidden />
      <span>
        Real ladder win rates for {target.name} ({canonical}):{" "}
        <Link href={guidePaths.build(slug, target.buildSlug)} className={GUIDE_LINK_CLASS}>
          Read the community guide
        </Link>
      </span>
    </p>
  );
}
