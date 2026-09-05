"use client";

/**
 * MapReplaySection — fetch-and-render host for the map replayer.
 *
 * GET /v1/games/:id/map-playback returns the compact playback payload
 * for games synced by playback-capable agents, or 404
 * ``playback_not_computed`` for older uploads. Both hosts (the game
 * page's analysis flow and the macro-breakdown drilldown) embed this
 * one component so the data path, sanitizing, and empty states never
 * drift apart.
 *
 * Two presentations over the same payload:
 *
 *  - full page  → ``ReplayStage``, the vespene-style HUD: mirrored top
 *    bar, production rail, live build-order feed, transport dock with
 *    event markers.
 *  - ``compact`` (the macro drilldown modal) → ``CompactReplayHost``:
 *    the same bare ``MapReplayer`` as before plus a one-control strip
 *    carrying the background score. The requirement there is still "map
 *    and transport only, no rails", which is exactly what the
 *    replayer's own chrome already is, and it keeps the drilldown's
 *    units-lost panels that hosts have shipped with since the replayer
 *    landed — the score was simply unreachable in this host, because
 *    ``MusicControl`` only ever lived in ``ReplayStage``'s dock.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { sanitizeMapPlayback } from "@/lib/mapReplay";
import { CompactReplayHost } from "./replay/CompactReplayHost";
import { ReplayStage } from "./replay/ReplayStage";

/** Stage height cap for the compact (drilldown) host, in CSS px. The
 * full-page host passes none and the replayer sizes itself to the
 * viewport like a video player. */
const COMPACT_STAGE_MAX_H_PX = 420;

export function MapReplaySection({
  gameId,
  compact = false,
  maxHeightPx,
  myName,
  oppName,
  myRace,
  oppRace,
  buildName,
  buildMatchPct,
}: {
  gameId: string;
  /** Drilldown hosts hide entirely (no hint card) when absent. */
  compact?: boolean;
  /** Override the stage height cap. Defaults to the viewport-sized
   * stage, or ``COMPACT_STAGE_MAX_H_PX`` in compact hosts. */
  maxHeightPx?: number;
  /* The playback payload carries no player identity, no race and no
   * build detection — those live on the game row and the build-order
   * endpoint, which the hosts have already fetched. Pass them through
   * and the HUD uses them; omit them and it falls back to
   * "You" / "Opponent" with no race icon and a heuristic opening read
   * off the first structures placed. */
  myName?: string | null;
  oppName?: string | null;
  myRace?: string | null;
  oppRace?: string | null;
  buildName?: string | null;
  buildMatchPct?: number | null;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState("");
  const refreshStarted = useRef(0);
  const [refreshRequestId, setRefreshRequestId] = useState<string | null>(null);
  const refreshGeneration = useRef(0);
  const startedWithEnginePlayback = useRef(false);
  const requestedGame = useRef(gameId);
  const req = useApi<Record<string, unknown>>(
    gameId ? `/v1/games/${encodeURIComponent(gameId)}/map-playback` : null,
    { revalidateOnFocus: false, refreshInterval: refreshing ? 3000 : 0 },
  );
  const playback = useMemo(
    () => (req.data ? sanitizeMapPlayback(req.data) : null),
    [req.data],
  );

  useEffect(() => {
    requestedGame.current = gameId;
    refreshGeneration.current += 1;
    setRefreshRequestId(null);
    setRefreshing(false);
    setRefreshMessage("");
    return () => { refreshGeneration.current += 1; };
  }, [gameId]);
  useEffect(() => {
    if (!refreshing) return;
    const rebuild = req.data?.rebuild as { status?: string; message?: string; requestId?: string } | undefined;
    const sameJob = refreshRequestId !== null && rebuild?.requestId === refreshRequestId;
    if (rebuild?.status === "failed" && sameJob) {
      setRefreshing(false);
      setRefreshMessage(rebuild.message || "Recording failed. Keep the desktop agent open and try again.");
      return;
    }
    // An already cached engine payload cannot prove that a newly requested
    // rebuild finished. Wait for this job's upload, or a first engine payload
    // replacing tracker data, and never report success before its ACK.
    if (refreshRequestId && playback?.fidelity?.positions === "engine" &&
        playback.fidelity.complete === true && playback.fidelity.attacks === "observed" &&
        (!startedWithEnginePlayback.current || (sameJob && rebuild?.status === "complete"))) {
      setRefreshing(false);
      setRefreshMessage("Recorded playback is ready.");
      return;
    }
    if (rebuild?.status === "complete" && sameJob && playback?.fidelity?.positions === "engine") {
      setRefreshing(false);
      setRefreshMessage(playback.fidelity.attacks === "observed"
        ? "Recorded playback is ready with reduced detail for this large replay."
        : "Movement is ready, but this recording has no attack data. Update the desktop agent and generate playback again.");
      return;
    }
    if (req.error && req.error.code !== "playback_not_computed") {
      if ([401, 403].includes(req.error.status) || req.error.code === "game_not_found") {
        setRefreshing(false);
        setRefreshMessage(req.error.message || "This replay is no longer available. Sign in again and reopen it.");
        return;
      }
      setRefreshMessage("Could not check recording progress. Retrying while your desktop agent continues working…");
    } else if (sameJob && rebuild?.status === "uploading") {
      setRefreshMessage("Recording finished. Uploading the map playback…");
    }
    const timer = window.setTimeout(() => {
      setRefreshing(false);
      setRefreshMessage("Recording is still processing. Keep the desktop agent open and check back shortly.");
    }, Math.max(0, 18 * 60 * 1000 - (Date.now() - refreshStarted.current)));
    return () => window.clearTimeout(timer);
  }, [refreshing, refreshRequestId, playback, req.data, req.error]);

  const refresh = async () => {
    if (refreshing || !req.request) return;
    const id = gameId;
    const generation = ++refreshGeneration.current;
    startedWithEnginePlayback.current = playback?.fidelity?.positions === "engine";
    setRefreshing(true);
    setRefreshRequestId(null);
    setRefreshMessage("Preparing recorded playback with your desktop agent…");
    refreshStarted.current = Date.now();
    try {
      const accepted = await req.request<{ requestId?: string; rebuild?: { requestId?: string } }>({ method: "POST", body: JSON.stringify({ fidelity: "engine" }) });
      if (requestedGame.current !== id || refreshGeneration.current !== generation) return;
      const requestId = accepted?.rebuild?.requestId ?? accepted?.requestId;
      if (typeof requestId !== "string" || !requestId) {
        throw new Error("The rebuild was not acknowledged. Update the desktop agent and try again.");
      }
      setRefreshRequestId(requestId);
      setRefreshMessage("Recording playback with StarCraft II. You can keep reviewing this game while it runs…");
      // A transient first GET failure must not cancel a job the agent has
      // already accepted. SWR keeps polling and the status effect reports it.
      await req.mutate().catch(() => undefined);
    } catch (error) {
      if (requestedGame.current !== id || refreshGeneration.current !== generation) return;
      setRefreshing(false);
      setRefreshMessage((error as { message?: string })?.message || "Could not refresh this replay. Check that your desktop agent is connected.");
    }
  };
  const refreshControl = typeof req.request === "function" && (playback?.fidelity?.positions !== "engine" || playback?.fidelity?.complete === false || playback?.fidelity?.attacks !== "observed" || refreshing || refreshMessage) ? (
    <div className="flex flex-wrap items-center gap-2 text-caption">
      <button type="button" disabled={refreshing} onClick={refresh}
        className="rounded-md border border-border bg-bg-elevated px-3 py-1.5 font-medium text-text hover:border-accent disabled:cursor-wait disabled:opacity-60">
        {refreshing ? "Recording replay…" : "Generate accurate playback"}
      </button>
      <span role="status" className="text-text-dim">
        {refreshMessage || "Uses StarCraft II and the replay file on your desktop."}
      </span>
    </div>
  ) : null;

  const stageMaxH = maxHeightPx ?? (compact ? COMPACT_STAGE_MAX_H_PX : undefined);

  if (req.isLoading) {
    if (compact) return null;
    // Roughly canvas-shaped so the page doesn't jump when the replay
    // arrives (most ladder maps project close to square). Height
    // tracks the stage's own viewport sizing rather than the old
    // 720 px ceiling.
    return (
      <div
        className="aspect-square max-h-[78vh] w-full animate-pulse rounded-lg border border-border bg-bg-elevated/40"
        aria-busy="true"
        aria-label="Loading map replay"
      />
    );
  }
  if (!playback) {
    // 404 playback_not_computed (older agent upload) or junk payload —
    // a one-line hint beats an empty canvas, and nothing beats noise
    // in the compact drilldown.
    if (compact) return null;
    return (
      <div className="rounded-lg border border-border bg-bg-elevated/40 p-4">
        <div className="text-body font-medium text-text">Map replay</div>
        <p className="mt-1 text-caption text-text-dim">
          {req.error && req.error.status !== 404
            ? req.error.message || "Could not load map playback. Check your connection and try again."
            : "No playback data for this game — replays synced with the latest desktop agent include a full map replay (unit movements, buildings, and battles over time)."}
        </p>
        {refreshControl}
      </div>
    );
  }

  if (compact) {
    return (
      <section
        aria-label="Map replay"
        className="space-y-3 rounded-lg border border-border bg-bg-elevated/40 p-4"
      >
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-body font-medium text-text">Map replay</div>
          <span className="text-micro text-text-dim">
            {playback.mapName || ""}
          </span>
        </div>
        <CompactReplayHost
          playback={playback}
          gameId={gameId}
          myRace={myRace}
          maxHeightPx={stageMaxH}
        />
        {refreshControl}
      </section>
    );
  }

  return (
    <div className="space-y-2">
    <ReplayStage
      playback={playback}
      gameId={gameId}
      maxHeightPx={stageMaxH}
      myName={myName}
      oppName={oppName}
      myRace={myRace}
      oppRace={oppRace}
      buildName={buildName}
      buildMatchPct={buildMatchPct}
    />
    {refreshControl}
    </div>
  );
}
