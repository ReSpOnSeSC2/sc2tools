"use client";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { SkeletonBar, SkeletonRegion } from "@/components/ui/Skeleton";
import { formatDateTime } from "@/lib/i18n/format";
import { languageName, PLATFORM_NAMES, viewerLabel } from "@/lib/live/streams";
import { RAID_STATE_LABELS, RELATION_LABELS, type RaidCandidate, type RaidEntry } from "@/lib/twitchRaids";
import { DockButton } from "./DockControls";

/** The Dock's coarse-pointer sizes (40 px) come later in the stylesheet than a plain min-h, so touch sizes are restated for 44 px targets. */
export const RAID_TOUCH = "min-h-11 min-w-11 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";
const ROW = "grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 py-2";

/** One channel: the whole row opens it; Start raid sits above that link. */
export function RaidRow({ stream, canStart, busy, onStart }: { stream: RaidCandidate; canStart: boolean; busy: boolean; onStart: () => void }) {
  const platform = PLATFORM_NAMES[stream.platform];
  const facts = [viewerLabel(stream.viewers), languageName(stream.language), stream.relation ? RELATION_LABELS[stream.relation] : ""].filter(Boolean);
  return <li className={`relative ${ROW}`}>
    <div className="min-w-0">
      <p className="flex min-w-0 items-center gap-1.5">
        <a href={stream.url} target="_blank" rel="noopener noreferrer"
          className="min-w-0 truncate rounded-sm text-caption font-semibold text-text after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-accent">
          {stream.channel}<span className="sr-only"> (opens {platform} in a new tab)</span>
        </a>
        <Badge size="sm" variant={stream.platform === "twitch" ? "accent" : "success"} className="shrink-0">{platform}</Badge>
      </p>
      <p className="truncate text-micro text-text-muted">{facts.join(" · ")}</p>
    </div>
    {canStart && stream.raidable
      ? <DockButton disabled={busy} onClick={onStart} aria-label={`Start raid on ${stream.channel}`} className="relative z-10 min-h-11 min-w-24 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-24">Start raid</DockButton>
      : <ExternalLink aria-hidden className="size-4 text-text-muted" />}
  </li>;
}

/** The same grid as RaidRow, so the list does not jump when it arrives. */
export function RaidListSkeleton() {
  return <SkeletonRegion label="Loading live channels" className="divide-y divide-border">
    {[0, 1, 2, 3].map(row => <div key={row} aria-hidden className={ROW}>
      <div className="space-y-1.5"><SkeletonBar className="h-4 w-32 max-w-full" /><SkeletonBar className="h-3 w-44 max-w-full" /></div>
      <SkeletonBar className="h-11 w-24" />
    </div>)}
    <SkeletonBar className="h-11 w-full" />
  </SkeletonRegion>;
}

/** Raids out and in, newest first. A queued raid stays "Queued": Twitch does not report when it goes. */
export function RaidHistory({ entries }: { entries: RaidEntry[] }) {
  return <details className="group rounded-md border border-border">
    <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-caption font-semibold">
      Raid history<span className="font-normal text-text-muted">{entries.length}</span>
      <ChevronDown aria-hidden className="ml-auto size-4 text-text-muted transition-transform group-open:rotate-180 motion-reduce:transition-none" />
    </summary>
    {entries.length === 0 ? <p className="border-t border-border px-3 py-2 text-caption text-text-muted">No raids yet. Raids you send, and raids you receive while raids are switched on, appear here.</p>
      : <ul className="divide-y divide-border border-t border-border px-3">
        {entries.map(entry => <li key={entry.id} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 py-2 text-caption">
          {entry.dir === "out" ? <ArrowUpRight aria-label="Sent" className="mt-0.5 size-4 text-text-muted" /> : <ArrowDownLeft aria-label="Received" className="mt-0.5 size-4 text-text-muted" />}
          <div className="min-w-0">
            <p className="truncate font-semibold text-text">{entry.channel}</p>
            <p className="text-micro text-text-muted">
              {entry.dir === "in" ? `${viewerLabel(entry.viewers)} joined` : RAID_STATE_LABELS[entry.state]}
              {" · "}<time dateTime={new Date(entry.at).toISOString()}>{formatDateTime(entry.at, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
            </p>
          </div>
        </li>)}
      </ul>}
  </details>;
}
