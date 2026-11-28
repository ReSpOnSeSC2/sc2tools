"use client";
import Link from "next/link";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { degradedPlatforms, listingIsOff, platformList, viewerLabel } from "@/lib/live/streams";
import { BLOCKER_TEXT, PENDING_LABELS, PENDING_TEXT, type RaidCandidate, type RaidPending, type RaidView } from "@/lib/twitchRaids";
import { DockButton } from "./DockControls";
import { RAID_TOUCH, RaidListSkeleton, RaidRow } from "./DockRaidRows";

export type RaidConfirm = { kind: "start"; stream: RaidCandidate } | { kind: "cancel" } | null;

/**
 * A raid that may be live on Twitch, with its one action. `queuedElsewhere`
 * is a raid Twitch holds that this Dock has no record of. Cancel is offered
 * for everything except a raid still waiting for Twitch's answer.
 */
export function PendingBanner({ pending, queuedElsewhere, busy, onCancel }: { pending: RaidPending | null; queuedElsewhere: boolean; busy: boolean; onCancel: () => void }) {
  if (!pending && !queuedElsewhere) return null;
  const label = pending ? PENDING_LABELS[pending.state] : "Queued on Twitch";
  const detail = pending ? `raid to ${pending.channel}` : "not started here";
  const text = pending ? PENDING_TEXT[pending.state] : "Twitch already holds a raid for your channel. Cancel it to pick another.";
  return <div className="flex items-center justify-between gap-3 rounded-md border border-accent-cyan/40 bg-accent-cyan/10 px-3 py-2">
    <div className="min-w-0 flex-1">
      <p className="text-caption"><span className="font-semibold">{label}</span> · {detail}</p>
      <p className="text-micro text-text-muted">{text}</p>
    </div>
    {pending?.state === "pending" ? null
      : <DockButton danger data-raid-cancel disabled={busy} onClick={onCancel} className={`shrink-0 ${RAID_TOUCH}`}>Cancel raid</DockButton>}
  </div>;
}

/** Twitch's answer in place: a confirmed cancel, or the refusal with Retry while nothing has loaded yet. */
export function RaidStatus({ notice, error, canRetry, busy, onRetry }: { notice: string; error: string; canRetry: boolean; busy: boolean; onRetry: () => void }) {
  return <div aria-live="polite" className="space-y-2 empty:hidden">
    {notice ? <p role="status" tabIndex={-1} data-raid-notice className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-caption focus-visible:ring-2 focus-visible:ring-accent">{notice}</p> : null}
    {error ? <div className="flex items-center justify-between gap-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2">
      <p role="alert" className="min-w-0 flex-1 text-caption text-danger">{error}</p>
      {canRetry ? <DockButton disabled={busy} onClick={onRetry} className={`shrink-0 ${RAID_TOUCH}`}>Retry</DockButton> : null}
    </div> : null}
  </div>;
}

/** Why Start raid is off and which channels could not be listed, under the list so the rows never move. */
export function RaidNotes({ view }: { view: RaidView }) {
  const degraded = degradedPlatforms(view.platforms);
  if (!view.reason && degraded.length === 0) return null;
  return <div className="space-y-1">
    {view.reason ? <div>
      <p className="text-caption text-text-muted">{BLOCKER_TEXT[view.reason]}</p>
      <Link href="/settings?tab=chat#twitch-raids" target="_blank" rel="noopener noreferrer" prefetch={false} className="inline-flex min-h-11 items-center text-caption font-semibold text-link underline">Raid settings</Link>
    </div> : null}
    {degraded.length ? <p className="text-micro text-text-muted">{platformList(degraded)} could not be refreshed, so some channels may be missing.</p> : null}
  </div>;
}

/** Skeleton while the first answer is on its way, then the empty line or the ranked rows. */
export function RaidList({ view, canStart, busy, loading, onStart }: { view: RaidView | null; canStart: boolean; busy: boolean; loading: boolean; onStart: (stream: RaidCandidate) => void }) {
  if (!view) return loading ? <RaidListSkeleton /> : null;
  if (view.candidates.length === 0) {
    return <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-caption text-text-muted">
      {listingIsOff(view.platforms) ? "Live channel lists are not set up on this server." : "No StarCraft II channels are live right now."}
    </p>;
  }
  return <ul className="divide-y divide-border">
    {view.candidates.map(stream => <RaidRow key={stream.id} stream={stream} canStart={canStart} busy={busy} onStart={() => onStart(stream)} />)}
  </ul>;
}

/** Start and Cancel are each asked once, with the countdown stated. */
export function RaidConfirmDialog({ confirm, loading, onClose, onConfirm }: { confirm: RaidConfirm; loading: boolean; onClose: () => void; onConfirm: () => void }) {
  const starting = confirm?.kind === "start";
  return <ConfirmDialog open={confirm !== null} focusCancel loading={loading}
    title={starting ? `Raid ${confirm.stream.channel}?` : "Cancel the queued raid?"}
    description={starting
      ? `${viewerLabel(confirm.stream.viewers)} now. Twitch counts down 90 seconds, then sends your viewers there. You can cancel until it goes.`
      : "Twitch stops the countdown if the raid has not started yet. The Dock reports what Twitch answers."}
    confirmLabel={starting ? "Start raid" : "Cancel raid"} cancelLabel={starting ? "Not now" : "Keep raid"}
    intent={starting ? "primary" : "danger"} onClose={onClose} onConfirm={onConfirm} />;
}
