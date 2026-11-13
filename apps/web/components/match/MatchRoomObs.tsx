"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { OverlayCredit } from "@/components/overlay/OverlayCredit";
import { OverlayPlacement } from "@/components/overlay/OverlayPlacement";
import { WidgetShell } from "@/components/overlay/WidgetShell";
import { Button } from "@/components/ui/Button";
import { SkeletonBar, SkeletonRegion } from "@/components/ui/Skeleton";
import { parseMatchRoomObsInvite, seatLabel, SEATS, type RoomInvite } from "@/lib/matchRoom";
import { roomObsState } from "@/lib/matchRoomObs";
import { isOverlayCreditHidden, OVERLAY_CREDIT_PARAM } from "@/lib/overlayCredit";
import { getThemeMode, subscribeTheme, systemPreference, THEME_ATTRIBUTE } from "@/lib/theme";
import { useMatchRoom } from "./useMatchRoom";
import { useVetoCountdown } from "./useVetoCountdown";

type ObsState = ReturnType<typeof roomObsState>;
type LadderTitles = { ladderTitles: readonly string[] };
const PLACEMENT = { anchor: "top", xPct: 50, yPct: 5, scale: 1, zIndex: 1 } as const;

function observeFragment(callback: () => void) {
  window.addEventListener("hashchange", callback);
  window.addEventListener("popstate", callback);
  return () => {
    window.removeEventListener("hashchange", callback);
    window.removeEventListener("popstate", callback);
  };
}

function ObsVetoBoard({ state, seconds }: { state: ObsState; seconds: number | null }) {
  const { turn, maps, readyCount } = state;
  return <section className="space-y-2" aria-label="Map veto">
    <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-2">
      <p className="text-body font-semibold" aria-live="polite">{turn
        ? seatLabel(turn.seat) + " to " + turn.kind : readyCount + "/2 players ready"}</p>
      {seconds !== null && <p role="timer" aria-label="Veto time remaining" className="text-caption tabular-nums">{seconds}s</p>}
    </div>
    <ul className={"grid grid-cols-2 gap-1.5" + (maps.length > 10 ? " sm:grid-cols-4" : "")}>
      {maps.map(({ label, move }, index) => <li key={index} className="min-w-0 rounded border border-line px-2 py-1 text-caption">
        <p className="break-words font-semibold">{label}</p>
        <p className="text-text-muted">{move ? (move.kind === "ban" ? "Banned by " : "Picked by ") + seatLabel(move.seat) : "Available"}</p>
      </li>)}
    </ul>
  </section>;
}

function ObsScore({ state }: { state: ObsState }) {
  return <section className="space-y-2" aria-label="Series score">
    <dl className="grid grid-cols-2 gap-2" aria-live="polite" aria-atomic="true">
      {SEATS.map(seat => <div key={seat} className="rounded-md border border-line bg-bg-elevated p-2 text-center">
        <dt className="text-caption font-semibold text-text-muted">{seatLabel(seat)}</dt>
        <dd className="font-display text-h1 font-bold tabular-nums">{state.score[seat]}</dd>
      </div>)}
    </dl>
    <p className="text-caption text-text-muted">{state.phase === "complete"
      ? "Series complete" : state.nextMap ? "Next up: " + state.nextMap : "Next map pending"}</p>
  </section>;
}

function ObsMatch({ frame, ladderTitles }: LadderTitles & { frame: NonNullable<ReturnType<typeof useMatchRoom>["frame"]> }) {
  const { room, receivedAt } = frame;
  const seconds = useVetoCountdown(room.deadline, room.serverTime, receivedAt);
  const state = roomObsState(room, ladderTitles);
  const scoring = state.phase === "play" || state.phase === "complete";
  return <>
    <div className="mb-2 flex items-baseline justify-between gap-2">
      <h1 className="font-display text-h3 font-bold">{scoring ? "Series score" : "Map veto"}</h1>
      <p className="shrink-0 text-caption text-text-muted">Best of {state.bestOf}</p>
    </div>
    {scoring ? <ObsScore state={state} /> : <ObsVetoBoard state={state} seconds={seconds} />}
  </>;
}

function ObsStatus({ title, detail, retry }: { title: string; detail: string; retry?: () => void }) {
  return <div className="min-h-24 space-y-2">
    <h1 className="font-display text-h3 font-bold">{title}</h1>
    <p className="text-caption text-text-muted" role="status">{detail}</p>
    {retry && <Button variant="secondary" className="pointer-events-auto" onClick={retry}>Retry connection</Button>}
  </div>;
}

function ObsLoading() {
  return <SkeletonRegion label="Connecting to the match room" className="min-h-24 space-y-3">
    <SkeletonBar className="h-6 w-32" />
    <div className="grid grid-cols-2 gap-2"><SkeletonBar className="h-14" /><SkeletonBar className="h-14" /></div>
  </SkeletonRegion>;
}

function ObsPanel({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const width = wide ? "min(576px, calc(100vw - 24px))" : "min(328px, calc(100vw - 24px))";
  return <WidgetShell width={width}>{children}</WidgetShell>;
}

function ObsConnection({ invite, showCredit, ladderTitles }: LadderTitles & {
  invite: Extract<RoomInvite, { role: "watch" }>;
  showCredit: boolean;
}) {
  const { frame, reading, retry } = useMatchRoom(invite, "obs");
  if (reading.gone) return <ObsPanel><ObsStatus title="Room unavailable" detail="This room expired or was deleted." /></ObsPanel>;
  if (reading.error) return <ObsPanel><ObsStatus title="Connection lost" detail="Reconnecting to the match room." retry={retry} /></ObsPanel>;
  if (!frame) return <ObsPanel><ObsLoading /></ObsPanel>;
  const { phase, config } = frame.room;
  return <ObsPanel wide={(phase === "lobby" || phase === "veto") && config.maps.length > 10}>
    <ObsMatch frame={frame} ladderTitles={ladderTitles} /><OverlayCredit placement="inline" visible={showCredit} />
  </ObsPanel>;
}

function ObsSource({ source, ladderTitles }: LadderTitles & { source: string }) {
  const hashAt = source.indexOf("#");
  const invite = hashAt === -1 ? null : parseMatchRoomObsInvite(source.slice(hashAt));
  if (!invite) return <ObsPanel><ObsStatus title="Open an OBS source link"
    detail="Copy the OBS Browser Source link from the host's Match Room." /></ObsPanel>;
  const query = new URLSearchParams(source.slice(0, hashAt));
  return <ObsConnection key={invite.id} invite={invite} ladderTitles={ladderTitles}
    showCredit={!isOverlayCreditHidden(query.get(OVERLAY_CREDIT_PARAM))} />;
}

function useBroadcastTheme() {
  useEffect(() => {
    const root = document.documentElement;
    const forceDark = () => {
      root.setAttribute(THEME_ATTRIBUTE, "dark");
      root.style.colorScheme = "dark";
    };
    const unsubscribe = subscribeTheme(forceDark);
    forceDark();
    return () => {
      unsubscribe();
      const mode = getThemeMode();
      const theme = mode === "system" ? systemPreference() : mode;
      root.setAttribute(THEME_ATTRIBUTE, theme);
      root.style.colorScheme = theme;
    };
  }, []);
}

export function MatchRoomObs({ ladderTitles }: LadderTitles) {
  useBroadcastTheme();
  const source = useSyncExternalStore(observeFragment, () => window.location.search + window.location.hash, () => null);
  return <OverlayPlacement placement={PLACEMENT}>
    {source === null ? <ObsPanel><ObsLoading /></ObsPanel> : <ObsSource source={source} ladderTitles={ladderTitles} />}
  </OverlayPlacement>;
}
