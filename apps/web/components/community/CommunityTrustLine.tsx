import { Bookmark } from "lucide-react";
import type { CommunityBuildListItem } from "./types";

/**
 * A community card's trust signals: how many players saved it, and the
 * author's record with it when the author chose to show it.
 */
export function CommunityTrustLine({ build }: { build: Pick<CommunityBuildListItem, "saves" | "authorRecord"> }) {
  const saves = Math.max(0, build.saves ?? 0);
  return (
    <>
      <span className="inline-flex items-center gap-1 text-micro text-text-dim" title="Players who saved it to their library">
        <Bookmark className="h-3.5 w-3.5" aria-hidden />
        {saves === 1 ? "1 save" : `${saves} saves`}
      </span>
      {build.authorRecord ? (
        <span className="text-micro tabular-nums text-text-muted" title="The author's record with this build">
          Author {build.authorRecord.wins}–{build.authorRecord.losses}
        </span>
      ) : null}
    </>
  );
}
