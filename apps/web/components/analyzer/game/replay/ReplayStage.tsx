"use client";

/**
 * ReplayStage — the full-bleed HUD that surrounds the map canvas.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  you  ◂ stats ┊ 8:42 ┊ stats ▸  opponent                 │  top bar
 *   ├───────────┬──────────────────────────────┬───────────────┤
 *   │ Production│         MapReplayer          │  Build order  │  rails
 *   ├───────────┴──────────────────────────────┴───────────────┤
 *   │ ⏮ ▶ 8×  ░░░░●░░░░░░░░░░░░░░  8:42 / 21:07            ⚙  │  transport
 *   └──────────────────────────────────────────────────────────┘
 *
 * This component owns the ONE playback clock. ``MapReplayer`` still
 * runs it — the rAF loop advances ``timeRef`` at 60 fps and publishes
 * to React at ~4 Hz — and this shell holds the published value, so the
 * canvas animates at 60 fps while the panels re-render four times a
 * second. Seeking from the scrubber, a marker dot or a build-order row
 * pushes the new time back down through the controlled ``time`` prop.
 *
 * PERFORMANCE CONTRACT
 *  - ``deriveReplayHud`` runs ONCE per payload (``useMemo`` on
 *    ``playback``): build-order feed, derived production windows,
 *    supply-cap steps, cumulative losses and timeline markers.
 *  - Every panel is ``memo``-wrapped and every callback handed to one
 *    is a stable ``useCallback`` or a bare ``useState`` setter, so a
 *    4 Hz tick re-renders exactly the panels whose numbers moved.
 *  - Per-tick work is O(live units) at worst (the composition scan) —
 *    a few thousand comparisons a second against a 16.7 ms frame
 *    budget that belongs entirely to the canvas.
 *  - Nothing here subscribes to rAF, and no panel touches the sprite
 *    module's per-frame state.
 *
 * RESPONSIVE. One instance of each rail (no duplicated DOM, no
 * duplicated ids), repositioned with flex ``order``: three columns at
 * ``xl``, and below that a single column with the MAP FIRST and the
 * rails stacked under it, each capped at ``max-h-80`` and scrolling.
 * The map never shrinks to make room for a rail.
 */

import { useCallback, useMemo, useState } from "react";
import type { MapPlayback } from "@/lib/mapReplay";
import {
  deriveReplayHud,
  hudAt,
  type BankedSeries,
  type ReplaySide,
} from "@/lib/replayHud";
import { useReplayMusic } from "@/lib/replayMusic";
import { MapReplayer } from "../MapReplayer";
import { ReplayTopBar } from "./ReplayTopBar";
import { ProductionRail, type ProductionTab } from "./ProductionRail";
import { BuildOrderRail, type BuildFilter } from "./BuildOrderRail";
import { ReplaySettings } from "./ReplaySettings";
import { TransportDock, type ReplaySpeed } from "./TransportDock";
import { STAGE_BG } from "./replayTheme";

export function ReplayStage({
  playback,
  gameId,
  myName,
  oppName,
  myRace,
  oppRace,
  buildName,
  buildMatchPct,
  banked,
  maxHeightPx,
}: {
  playback: MapPlayback;
  /** Only used to seed the background score, so the same replay always
   *  gets the same track. Omitted, the seed falls back to a
   *  fingerprint of the payload — still stable per game. */
  gameId?: string | null;
  /** Falls back to "You" / "Opponent" — MapPlayback has no names. */
  myName?: string | null;
  oppName?: string | null;
  myRace?: string | null;
  oppRace?: string | null;
  /** Detected build for the rail header, from whatever endpoint the
   *  host already fetched. MapPlayback does not carry one. */
  buildName?: string | null;
  /** Percentage match against a reference build. Rendered only when
   *  supplied — there is no reference build in MapPlayback. */
  buildMatchPct?: number | null;
  /** Optional ``[t, minerals, gas]`` banked-resource rows per side (the
   *  macro breakdown's ``stats_events``). Without it the top bar omits
   *  the minerals/gas fields rather than inventing them. Pass a stable
   *  (memoised) object — it is a ``useMemo`` dependency. */
  banked?: BankedSeries;
  maxHeightPx?: number;
}) {
  const model = useMemo(() => deriveReplayHud(playback), [playback]);

  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(8);

  const [showProduction, setShowProduction] = useState(true);
  const [showBuildOrder, setShowBuildOrder] = useState(true);
  const [productionSide, setProductionSide] = useState<ReplaySide>("me");
  const [productionTab, setProductionTab] = useState<ProductionTab>("queue");
  const [buildFilter, setBuildFilter] = useState<BuildFilter>("both");
  const [showWorkers, setShowWorkers] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  // The background score. It reads the clock (for the battle swell)
  // but drives nothing — the replay is unaware of it, and it is
  // impossible for it to stall or throw into the render path.
  const music = useReplayMusic({ playback, gameId, myRace, time, speed });
  const { setPlaying: setMusicPlaying } = music;

  // Echoed back to MapReplayer VERBATIM — it compares by identity to
  // tell its own 4 Hz tick apart from an external seek.
  const onTimeChange = useCallback((next: number) => setTime(next), []);
  const seek = useCallback((next: number) => setTime(next), []);
  const onPlayingChange = useCallback(
    (next: boolean) => {
      // Synchronous, still inside the transport's click handler: that
      // click is the user gesture browsers demand before an
      // AudioContext may start, so the score has to be told here
      // rather than from an effect on ``playing``.
      setMusicPlaying(next);
      setPlaying(next);
    },
    [setMusicPlaying],
  );
  const onSpeedChange = useCallback((next: ReplaySpeed) => setSpeed(next), []);

  const hud = useMemo(
    () => hudAt(model, playback, time, banked),
    [model, playback, time, banked],
  );

  return (
    <section
      data-testid="replay-stage"
      /* Stable label: hosts and their tests have keyed off
         ``aria-label="Map replay"`` since the replayer shipped. The map
         name is in the top bar. */
      aria-label="Map replay"
      className="overflow-hidden rounded-xl border border-border"
      style={{ background: STAGE_BG }}
    >
      <ReplayTopBar
        t={time}
        gameLength={model.gameLength}
        hud={hud}
        mapName={playback.mapName}
        myName={myName}
        oppName={oppName}
        myRace={myRace}
        oppRace={oppRace}
      />

      <div className="flex flex-col gap-2 p-2 lg:gap-3 lg:p-3 xl:flex-row xl:items-stretch">
        {showProduction ? (
          <ProductionRail
            model={model}
            playback={playback}
            side={productionSide}
            t={time}
            tab={productionTab}
            onTabChange={setProductionTab}
            onSideChange={setProductionSide}
            myName={myName}
            oppName={oppName}
            className="order-2 flex max-h-80 xl:order-1 xl:max-h-none xl:w-[13.5rem] xl:shrink-0"
          />
        ) : null}

        <div className="order-1 flex min-w-0 flex-1 justify-center xl:order-2">
          <MapReplayer
            playback={playback}
            maxHeightPx={maxHeightPx}
            time={time}
            onTimeChange={onTimeChange}
            playing={playing}
            onPlayingChange={onPlayingChange}
            speed={speed}
            onSpeedChange={onSpeedChange}
            hideControls
          />
        </div>

        {showBuildOrder ? (
          <BuildOrderRail
            model={model}
            t={time}
            filter={buildFilter}
            onFilterChange={setBuildFilter}
            showWorkers={showWorkers}
            onShowWorkersChange={setShowWorkers}
            autoScroll={autoScroll}
            onAutoScrollChange={setAutoScroll}
            onSeek={seek}
            buildName={buildName}
            buildMatchPct={buildMatchPct}
            myName={myName}
            oppName={oppName}
            className="order-3 flex max-h-80 xl:max-h-none xl:w-[15rem] xl:shrink-0"
          />
        ) : null}
      </div>

      <TransportDock
        t={time}
        gameLength={model.gameLength}
        playing={playing}
        speed={speed}
        markers={model.markers}
        phases={model.phases}
        onSeek={seek}
        onPlayingChange={onPlayingChange}
        onSpeedChange={onSpeedChange}
        music={music}
      >
        <ReplaySettings
          showProductionRail={showProduction}
          onShowProductionRail={setShowProduction}
          showBuildOrderRail={showBuildOrder}
          onShowBuildOrderRail={setShowBuildOrder}
          productionSide={productionSide}
          onProductionSide={setProductionSide}
          myName={myName}
          oppName={oppName}
        />
      </TransportDock>
    </section>
  );
}
