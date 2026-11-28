"use client";
import { useId, useState } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { degradedPlatforms, listingIsOff, platformList, viewerLabel } from "@/lib/live/streams";
import { BLOCKER_TEXT, type RaidCandidate } from "@/lib/twitchRaids";
import { DockButton } from "./DockControls";
import { RaidHistory, RaidListSkeleton, RaidRow } from "./DockRaidRows";
import { useDockRaids } from "./useDockRaids";

type Confirm = { kind: "start"; stream: RaidCandidate } | { kind: "cancel" } | null;

/**
 * Raid finder for the Stream ending scene: live StarCraft II channels, small
 * channels first, and one confirmed click to raid one. Twitch's answer is
 * shown here, in place. Loaded on demand, so the Dock's first load is unchanged.
 */
export function DockRaidFinder({ token }: { token: string }) {
  const titleId = useId();
  const { view, error, notice, busy, refresh, start, cancel } = useDockRaids(token);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const canStart = view !== null && view.reason === null && view.pending === null;
  const degraded = view ? degradedPlatforms(view.platforms) : [];
  const run = async () => {
    if (!confirm) return;
    await (confirm.kind === "start" ? start(confirm.stream.id) : cancel());
    setConfirm(null);
  };
  return <section aria-labelledby={titleId} className="min-w-0 space-y-3 rounded-lg border border-border bg-bg-elevated/40 p-3">
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 id={titleId} className="text-caption font-semibold">Raid a channel</h3>
        <p className="text-micro text-text-muted">Live StarCraft II channels, smallest first.</p>
      </div>
      <DockButton aria-label="Refresh channels" disabled={busy !== null} onClick={() => void refresh()} className="min-h-11 min-w-11 shrink-0">
        <RefreshCw aria-hidden className={`size-4 ${busy === "refresh" ? "motion-safe:animate-spin" : ""}`} />
      </DockButton>
    </header>
    <div aria-live="polite" className="space-y-2 empty:hidden">
      {notice ? <p role="status" className="rounded-md border border-success/40 bg-success/10 px-2.5 py-2 text-caption">{notice}</p> : null}
      {error ? <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-2 text-caption text-danger">{error}</p> : null}
    </div>
    {view?.pending ? <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-accent-cyan/40 bg-accent-cyan/10 px-2.5 py-2">
      <p className="min-w-0 text-caption"><span className="font-semibold">Queued</span> · raid to {view.pending.channel}</p>
      <DockButton danger disabled={busy !== null} onClick={() => setConfirm({ kind: "cancel" })} className="min-h-11">Cancel raid</DockButton>
    </div> : null}
    {view?.reason ? <p className="text-caption text-text-muted">
      {BLOCKER_TEXT[view.reason]}{" "}
      <Link href="/settings?tab=chat#twitch-raids" target="_blank" rel="noopener noreferrer" prefetch={false} className="inline-flex min-h-11 items-center font-semibold text-link underline">Raid settings</Link>
    </p> : null}
    {degraded.length ? <p className="text-micro text-text-muted">{platformList(degraded)} could not be refreshed, so some channels may be missing.</p> : null}
    {!view && busy ? <RaidListSkeleton /> : null}
    {!view && !busy ? <p className="text-caption text-text-muted">The channel list could not load. Use Refresh to try again.</p> : null}
    {view && view.candidates.length === 0 ? <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-caption text-text-muted">
      {listingIsOff(view.platforms) ? "Live channel lists are not set up on this server." : "No StarCraft II channels are live right now."}
    </p> : null}
    {view && view.candidates.length > 0 ? <ul className="divide-y divide-border">
      {view.candidates.map(stream => <RaidRow key={stream.id} stream={stream} canStart={canStart} busy={busy !== null} onStart={() => setConfirm({ kind: "start", stream })} />)}
    </ul> : null}
    {view ? <RaidHistory entries={view.history} /> : null}
    <ConfirmDialog open={confirm !== null} focusCancel loading={busy === "start" || busy === "cancel"}
      title={confirm?.kind === "start" ? `Raid ${confirm.stream.channel}?` : "Cancel the queued raid?"}
      description={confirm?.kind === "start"
        ? `${viewerLabel(confirm.stream.viewers)} now. Twitch counts down 90 seconds, then sends your viewers there. You can cancel until it goes.`
        : "Twitch stops the countdown if the raid has not started yet. The Dock reports what Twitch answers."}
      confirmLabel={confirm?.kind === "start" ? "Start raid" : "Cancel raid"} cancelLabel={confirm?.kind === "start" ? "Not now" : "Keep raid"}
      intent={confirm?.kind === "cancel" ? "danger" : "primary"}
      onClose={() => { if (busy === null) setConfirm(null); }} onConfirm={() => void run()} />
  </section>;
}
