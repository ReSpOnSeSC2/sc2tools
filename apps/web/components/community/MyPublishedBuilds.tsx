"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { Card, Skeleton } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { QueryState } from "@/components/ui/QueryState";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { fmtDay } from "@/lib/format";
import { signInHref } from "@/lib/authLinks";
import { VoteScore } from "./VoteScore";
import { CommunityBuildRecord } from "./CommunityBuildRecord";
import { useOwnerBuilds } from "./useOwnerBuilds";

export function MyPublishedBuilds() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  if (!isLoaded) return <Skeleton rows={3} />;
  if (!isSignedIn) return <Card><EmptyStatePanel title="Sign in to see your published builds" description="Your publication record is visible only to you." action={<LinkButton href={signInHref("/community?mine=1")}>Sign in</LinkButton>} /></Card>;
  return <OwnerList key={userId} />;
}

function OwnerList() {
  const query = useOwnerBuilds();
  return <QueryState q={query} skeleton={<Skeleton rows={3} />} errorTitle="Your published builds are temporarily unavailable" isEmpty={(data) => !data.items.length} empty={<Card><EmptyStatePanel title="You haven't published any builds yet" description="Choose a saved build from your private library to share." action={<LinkButton href="/builds?publish=1">Publish a build</LinkButton>} /></Card>}>
    {(data) => <div className="space-y-3"><p className="text-caption text-text-muted">Your record comes from your classified replays and is visible only to you.{data.items.length === 200 ? " Showing your 200 most recently updated publications." : ""}</p>
      <ul aria-label="My published builds" className="space-y-3">{data.items.map((build) => <li key={build.slug}><Card><div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2"><Badge size="sm" variant="neutral">{build.matchup || "Any matchup"}</Badge>{build.publishAnonymously ? <Badge size="sm" variant="neutral">Anonymous</Badge> : null}{build.removed ? <Badge size="sm" variant={build.removedByModerator ? "danger" : "neutral"}>{build.removedByModerator ? "Removed by a moderator" : "Not published"}</Badge> : null}</div>
        <h2 className="break-words text-h4 font-semibold text-text"><Link href={`/community/builds/${encodeURIComponent(build.slug)}`} className="rounded-md hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{build.title}</Link></h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><VoteScore votes={build.votes} /><span className="text-caption text-text-muted">{build.upCount} up · {build.downCount} down</span><CommunityBuildRecord record={build} /></div>
        <p className="text-caption text-text-muted">Published {fmtDay(build.publishedAt)} · Updated {fmtDay(build.updatedAt || build.publishedAt)}</p>
        <div className="flex flex-wrap gap-2">{build.sourceSlug ? <><LinkButton href={`/builds/${encodeURIComponent(build.sourceSlug)}`} variant="secondary" size="sm" className="min-h-11">Edit in library</LinkButton><LinkButton href={`/builds?publish=${encodeURIComponent(build.sourceSlug)}`} variant="ghost" size="sm" className="min-h-11">Publish update</LinkButton></> : <LinkButton href="/builds" variant="secondary" size="sm">Open my library</LinkButton>}</div>
      </div></Card></li>)}</ul>
    </div>}
  </QueryState>;
}
