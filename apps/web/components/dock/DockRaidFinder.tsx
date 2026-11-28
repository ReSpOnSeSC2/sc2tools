"use client";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { RefreshCw } from "lucide-react";
import { DockButton } from "./DockControls";
import { PendingBanner, RaidConfirmDialog, RaidList, RaidNotes, RaidStatus, type RaidConfirm } from "./DockRaidPanels";
import { RAID_TOUCH, RaidHistory } from "./DockRaidRows";
import { useDockRaids } from "./useDockRaids";

/**
 * After a confirmed action the button that opened the dialog may be gone, and
 * the dialog would leave keyboard focus on the page body. Focus goes to the
 * next thing to do instead: Cancel raid, or the answer.
 */
function useFocusAfterAction(panel: RefObject<HTMLElement | null>, dialogOpen: boolean) {
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    if (!requested || dialogOpen) return;
    setRequested(false);
    const root = panel.current;
    if (!root || root.contains(document.activeElement)) return;
    (root.querySelector<HTMLElement>("[data-raid-cancel]") ?? root.querySelector<HTMLElement>("[data-raid-notice]"))?.focus();
  }, [requested, dialogOpen, panel]);
  return () => setRequested(true);
}

/**
 * Raid finder for the Stream ending scene: live StarCraft II channels, small
 * channels first, and one confirmed click to raid one. Twitch's answer is
 * shown here, in place. Loaded on demand, so the Dock's first load is unchanged.
 */
export function DockRaidFinder({ token }: { token: string }) {
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  const { view, error, queuedElsewhere, notice, busy, refresh, start, cancel } = useDockRaids(token);
  const [confirm, setConfirm] = useState<RaidConfirm>(null);
  const focusNext = useFocusAfterAction(panel, confirm !== null);
  const canStart = view !== null && view.reason === null && view.pending === null && !queuedElsewhere;
  const run = async () => {
    if (!confirm) return;
    await (confirm.kind === "start" ? start(confirm.stream.id) : cancel());
    setConfirm(null);
    focusNext();
  };
  return <section ref={panel} aria-labelledby={titleId} className="min-w-0 space-y-3 rounded-lg border border-border bg-bg-elevated/40 p-3">
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 id={titleId} className="text-caption font-semibold">Raid a channel</h3>
        <p className="text-micro text-text-muted">Small channels first, then channels you raided or that raided you.</p>
      </div>
      <DockButton aria-label="Refresh channels" disabled={busy !== null} onClick={() => void refresh()} className={`shrink-0 ${RAID_TOUCH}`}>
        <RefreshCw aria-hidden className={`size-4 ${busy === "refresh" ? "motion-safe:animate-spin" : ""}`} />
      </DockButton>
    </header>
    <RaidStatus notice={notice} error={error} canRetry={view === null} busy={busy !== null} onRetry={() => void refresh()} />
    <PendingBanner pending={view?.pending ?? null} queuedElsewhere={queuedElsewhere} busy={busy !== null} onCancel={() => setConfirm({ kind: "cancel" })} />
    <RaidList view={view} canStart={canStart} busy={busy !== null} loading={busy !== null} onStart={stream => setConfirm({ kind: "start", stream })} />
    {view ? <RaidNotes view={view} /> : null}
    {view ? <RaidHistory entries={view.history} /> : null}
    <RaidConfirmDialog confirm={confirm} loading={busy === "start" || busy === "cancel"}
      onClose={() => { if (busy === null) setConfirm(null); }} onConfirm={() => void run()} />
  </section>;
}
