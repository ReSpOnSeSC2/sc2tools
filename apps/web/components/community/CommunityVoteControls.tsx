"use client";

import Link from "next/link";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button, buttonClassName } from "@/components/ui/Button";
import { signInHref } from "@/lib/authLinks";
import { queuePendingIntent } from "@/lib/pendingIntent";
import { useCommunityVote } from "./useCommunityVote";
import { VoteScore } from "./VoteScore";

/** Both responsive views use the same authenticated SWR vote key. */
export function CommunityVoteControls({ slug, initialVotes, compact = false }: { slug: string; initialVotes: number; compact?: boolean }) {
  const vote = useCommunityVote(slug, initialVotes);
  const returnTo = `/community/builds/${encodeURIComponent(slug)}`;
  const authVote = (delta: -1 | 1) => <Link href={signInHref(returnTo)}
    onClick={() => queuePendingIntent("vote", { slug, delta }, returnTo)}
    aria-label={delta === 1 ? "Sign in to upvote" : "Sign in to downvote"}
    className={buttonClassName({ variant: "secondary", className: compact ? "min-h-11 w-11 px-0" : "min-h-11" })}>
    {delta === 1 ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
    {compact ? null : delta === 1 ? "Upvote" : "Downvote"}
  </Link>;
  const up = <Button variant="secondary" aria-label="Upvote" aria-pressed={vote.myVote === 1} onClick={() => void vote.cast(1)} disabled={vote.pending} iconLeft={<ChevronUp className="h-4 w-4" aria-hidden />} className={`${compact ? "min-h-11 w-11 px-0" : ""} ${vote.myVote === 1 ? "border-success bg-success/15 text-success" : ""}`}>{compact ? null : "Upvote"}</Button>;
  const down = <Button variant="secondary" aria-label="Downvote" aria-pressed={vote.myVote === -1} onClick={() => void vote.cast(-1)} disabled={vote.pending} iconLeft={<ChevronDown className="h-4 w-4" aria-hidden />} className={`${compact ? "min-h-11 w-11 px-0" : ""} ${vote.myVote === -1 ? "border-danger bg-danger/15 text-danger" : ""}`}>{compact ? null : "Downvote"}</Button>;
  return <div className="space-y-2">
    {!compact ? <div className="flex items-center justify-between gap-2"><span className="text-micro font-medium uppercase tracking-wider text-text-dim">Community votes</span><VoteScore votes={vote.votes} size="md" /></div> : null}
    {vote.authLoading ? <p role="status" className="text-caption text-text-muted">Loading voting…</p> : vote.authenticated ? <><div className={compact ? "flex items-center gap-2" : "grid grid-cols-2 gap-2"}>{up}{compact ? <VoteScore votes={vote.votes} /> : null}{down}</div>
      {!compact && vote.myVote ? <p className="text-caption text-text-muted">You {vote.myVote === 1 ? "upvoted" : "downvoted"} · <button type="button" disabled={vote.pending} onClick={() => void vote.cast(0)} className="min-h-11 font-semibold text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Undo</button></p> : null}
    </> : <div className="space-y-1">
      <div className={compact ? "flex items-center gap-2" : "grid grid-cols-2 gap-2"}>{authVote(1)}{compact ? <VoteScore votes={vote.votes} /> : null}{authVote(-1)}</div>
      <Link href={signInHref(returnTo)} className="inline-flex min-h-11 items-center text-caption font-semibold text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Sign in to vote</Link>
      <p className="text-micro text-text-muted">Choose a vote to finish it when you return.</p>
    </div>}
    {vote.completed ? <p role="status" className="text-caption text-success">Vote saved. <Link href={returnTo} className="font-semibold underline">View build</Link></p> : null}
    {vote.error ? <p role="alert" className="text-caption text-danger">{vote.error}</p> : null}
    {vote.retry ? <Button variant="secondary" className="min-h-11" onClick={vote.retry}>Retry voting</Button> : null}
  </div>;
}
