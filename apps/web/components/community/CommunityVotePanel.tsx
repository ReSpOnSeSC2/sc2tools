"use client";

import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { CommunityVoteControls } from "./CommunityVoteControls";

export interface CommunityVotePanelProps { slug: string; initialVotes: number }

export function CommunityVotePanel(props: CommunityVotePanelProps) {
  return <div className="space-y-3">
    <CommunityVoteControls {...props} />
    <LazyHelpLink slug="community-builds" anchor="voting">How voting works</LazyHelpLink>
  </div>;
}
