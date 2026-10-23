"use client";

import { SaveToLibraryButton } from "./SaveToLibraryButton";
import { ShareLinkButton } from "./ShareLinkButton";
import { CommunityVoteControls } from "./CommunityVoteControls";
import { CommunityBuildOwnerControls } from "./CommunityBuildOwnerControls";
import type { CommunityBuildDetail } from "./types";
import { SavedBuildExportMenu } from "@/components/builds/SavedBuildExportMenu";

/** Primary actions precede long rules on phones; desktop keeps its sidebar. */
export function CommunityBuildActionsBar({ build }: { build: CommunityBuildDetail }) {
  return <section aria-label="Build actions" className="space-y-3 lg:hidden">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="w-full min-w-0 sm:flex-1"><SaveToLibraryButton build={build.build} title={build.title} communitySlug={build.slug} version={build.updatedAt || build.publishedAt} /></div>
      <div className="flex items-start justify-between gap-3">
        <CommunityVoteControls slug={build.slug} initialVotes={build.votes ?? 0} compact />
        <div className="min-w-0"><ShareLinkButton path={`/community/builds/${encodeURIComponent(build.slug)}`} label="Share" className="min-h-11" /></div>
        <SavedBuildExportMenu build={build.build} meta={{ title: build.title, matchup: build.matchup, author: build.authorName, sourceUrl: `/community/builds/${encodeURIComponent(build.slug)}` }} />
      </div>
    </div>
    <CommunityBuildOwnerControls slug={build.slug} title={build.title} redirectAfterRemove compact />
  </section>;
}
