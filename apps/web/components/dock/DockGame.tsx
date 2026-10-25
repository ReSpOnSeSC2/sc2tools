"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LiveGameEnvelope, LiveGamePayload } from "@/components/overlay/types";
import type { StudioState } from "@/lib/multichat/useStudioState";
import type { DockGameStatus } from "@/lib/multichat/useStudioUpdates";
import type { EngagementSummary } from "@/lib/multichat/useEngagementState";
import { projectDockScouting } from "@/lib/liveScouting";
import { formatCountdown } from "@/lib/multichat/countdown";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DockButton } from "./DockControls";
import { DockCopyText } from "./DockCopyText";
import type { DockPost } from "./dockActions";
import { sessionRecord } from "./DockStatusHeader";

const PHASES = { idle: "Waiting for a game", menu: "In menu", match_loading: "Loading match", match_started: "Match started", match_in_progress: "In game", match_ended: "Match ended" };
const raceLetter = (race: string | null | undefined) => race && /^[PTZR]$/i.test(race[0]) ? race[0].toUpperCase() : "?";
type Action = { action: "predictionCancel" | "predictionResolve" | "sessionReset"; gameKey?: string; result?: "win" | "loss" };
export function DockGame({ token, live, lastLiveAt, gameStatus, session, studio, engagement, ready, busy, onPost }: {
  token: string; live: LiveGameEnvelope | null; lastLiveAt: number | null; gameStatus: DockGameStatus | null;
  session: LiveGamePayload["session"] | null; studio: StudioState; engagement: EngagementSummary; ready: boolean; busy: boolean; onPost: DockPost;
}) {
  const round = engagement.prediction;
  const sourceKey = JSON.stringify([token, live?.gameKey ?? gameStatus?.gameKey ?? gameStatus?.endedGameKey, live?.opponent?.name, live?.opponent?.toonHandle, live?.opponent?.profile?.pulse_character_id, round?.gameKey]);
  const source = useRef({ key: sourceKey }); if (source.current.key !== sourceKey) source.current = { key: sourceKey };
  const identity = source.current, mounted = useRef(true);
  const [confirm, setConfirm] = useState<{ identity: typeof identity; action: Action } | null>(null);
  const [receipt, setReceipt] = useState<{ identity: typeof identity; text: string; queued: boolean } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const progress = useRef<HTMLParagraphElement>(null);
  useEffect(() => { mounted.current = true; const timer = setInterval(() => setNow(Date.now()), 1000); return () => { mounted.current = false; clearInterval(timer); }; }, []);
  const received = typeof live?.receivedAt === "number" ? live.receivedAt : lastLiveAt;
  const opponent = projectDockScouting(received !== null && now - received <= 30_000 ? live : null);
  const endedKey = gameStatus?.endedGameKey ?? (gameStatus?.phase === "match_ended" ? gameStatus.gameKey : null);
  const endedAt = gameStatus?.endedAt ?? lastLiveAt;
  const manual = !!round && endedKey === round.gameKey && !!gameStatus && ["match_ended", "menu", "idle"].includes(gameStatus.phase) && !gameStatus.isReplay && !gameStatus.verified
    && endedAt !== null && now - endedAt <= 30 * 60_000;
  const activeConfirm = confirm?.identity === identity && (confirm.action.action !== "predictionResolve" || manual || busy) ? confirm.action : null;
  const canConfirm = ready && !busy && !!activeConfirm && (activeConfirm.action !== "predictionResolve" || manual);
  useLayoutEffect(() => { if (busy && activeConfirm) progress.current?.focus(); }, [busy, activeConfirm]);
  async function confirmAction() {
    if (!canConfirm || !activeConfirm) return;
    const saved = await onPost(activeConfirm);
    if (saved && mounted.current && source.current === identity) setConfirm(null);
  }
  async function shoutout() {
    if (!ready || busy || !opponent || !live?.gameKey) return;
    const saved = await onPost({ action: "shoutout", gameKey: live.gameKey });
    if (saved?.deskAction && mounted.current && source.current === identity) setReceipt({ identity, text: saved.deskAction.shoutoutText, queued: saved.deskAction.queued });
  }
  const remaining = round?.locksAtMs ? Math.max(0, round.locksAtMs - now) : 0;
  const matchup = `${raceLetter(live?.user?.race)}v${raceLetter(opponent?.race)}`;
  const hasChannel = !!live?.opponentChannels && [live.opponentChannels.twitch, live.opponentChannels.youtube].some(value => typeof value === "string" && value.length > 0);
  return <div className="space-y-3 text-caption">
    <div className="space-y-1"><p className="font-semibold">{gameStatus ? PHASES[gameStatus.phase] : "Waiting for game state"}</p>
      {opponent ? <><p className="break-words text-body font-semibold">{opponent.name || "Identifying opponent…"}</p><p>{opponent.race} · {opponent.mmr === null ? "MMR unavailable" : `${opponent.mmr} MMR`}{opponent.h2h ? ` · H2H ${opponent.h2h.wins}W–${opponent.h2h.losses}L` : " · H2H unavailable"}</p><p className="break-words">{matchup} · {typeof live?.map === "string" && live.map.trim() ? live.map.slice(0, 120) : "Map unavailable live"}</p><DockButton onClick={() => void shoutout()} disabled={!ready || busy || !hasChannel}>Shout out</DockButton>{!hasChannel ? <p className="text-text-muted">Approved channels unavailable for this opponent.</p> : null}</> : <p className="text-text-muted">Opponent details appear during your next match.</p>}
      {opponent && receipt?.identity === identity ? receipt.queued ? <p role="status">Shout-out queued in Twitch chat.</p> : <DockCopyText value={receipt.text} label="Copy shout-out" /> : null}
    </div>
    <div><p>{sessionRecord(session)}</p>{session?.streak ? <p>{session.streak.count} {session.streak.kind === "win" ? session.streak.count === 1 ? "win" : "wins" : session.streak.count === 1 ? "loss" : "losses"} in a row</p> : null}</div>
    <div className="space-y-2 rounded border border-border p-2"><h3 className="font-semibold">Crystal Ball</h3>{round ? <>
      <p className="break-words">{round.opponent ? `Round vs ${round.opponent}` : "Current round"} · {remaining > 0 ? `Locks in ${formatCountdown(remaining)}` : "Voting locked"}</p>
      <div role="progressbar" aria-label="Crystal Ball votes" aria-valuemin={0} aria-valuemax={round.tally.total || 1} aria-valuenow={round.tally.win} aria-valuetext={`${round.tally.win} win, ${round.tally.loss} loss`} className="h-2 overflow-hidden rounded bg-danger/30"><div className="h-full bg-success" style={{ width: `${round.tally.total ? round.tally.win / round.tally.total * 100 : 0}%` }} /></div>
      <p>{round.tally.win} Win · {round.tally.loss} Loss · {round.tally.total} calls</p>
      <div className="flex flex-wrap gap-2"><DockButton disabled={!ready || busy} onClick={() => setConfirm({ identity, action: { action: "predictionCancel", gameKey: round.gameKey } })}>Cancel round</DockButton>{(["win", "loss"] as const).map(result => <DockButton key={result} disabled={!ready || busy || !manual} onClick={() => setConfirm({ identity, action: { action: "predictionResolve", gameKey: round.gameKey, result } })}>Resolve {result === "win" ? "Win" : "Loss"}</DockButton>)}</div>
      <p className="text-text-muted">After the game ends, manual resolve stays available for 30 minutes until your next match or a verified result. Manual and cancelled rounds earn no points or oracle accuracy.</p>
    </> : <p className="text-text-muted">No open round. Crystal Ball opens automatically when a match starts.</p>}</div>
    <div className="flex flex-wrap gap-2"><DockButton disabled={!ready || busy} onClick={() => setConfirm({ identity, action: { action: "sessionReset" } })}>Start new session</DockButton><DockButton disabled={!ready || busy} onClick={() => void onPost({ action: "gamePause", paused: studio.gameWidgetsPaused !== true })}>{studio.gameWidgetsPaused ? "Show game widgets" : "Hide game widgets"}</DockButton></div>
    <p className="text-text-muted">Game overlays and scouting voice hide together. Chat, polls, scenes and timers keep running.</p>
    <ConfirmDialog open={!!activeConfirm} focusCancel loading={busy} onClose={() => { if (!busy) setConfirm(null); }} onConfirm={() => void confirmAction()} title={activeConfirm?.action === "sessionReset" ? "Start new session?" : activeConfirm?.action === "predictionCancel" ? "Cancel this round?" : `Resolve ${activeConfirm?.result === "win" ? "Win" : "Loss"} manually?`} confirmLabel={activeConfirm?.action === "sessionReset" ? "Start new session" : activeConfirm?.action === "predictionCancel" ? "Cancel round" : "Resolve manually"} description={activeConfirm?.action === "sessionReset" ? "Begin a new stream session and set its clip timestamp mark to now." : "No points or oracle accuracy will be recorded."}>
      <p ref={progress} tabIndex={-1} role="status">{busy ? "Saving game control…" : ""}</p>
    </ConfirmDialog>
  </div>;
}
