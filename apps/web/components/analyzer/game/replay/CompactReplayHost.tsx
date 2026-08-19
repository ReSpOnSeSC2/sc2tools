"use client";

/**
 * CompactReplayHost — the drilldown presentation: the bare
 * ``MapReplayer`` plus the one HUD control the compact host was
 * missing, the background score.
 *
 * WHY A HOST COMPONENT AND NOT A ``ReplayStage`` MODE
 *
 * The compact drilldown's requirement is "map and transport only, no
 * rails", and ``MapReplayer``'s own chrome already IS that transport —
 * play/pause, the speed row, the scrubber, the units-lost panels the
 * drilldown has shipped with since the replayer landed. Giving
 * ``ReplayStage`` a rail-less mode would mean rebuilding all of that
 * inside ``TransportDock`` (and dragging ``deriveReplayHud``, the
 * marker strip and the phase bands into a popover that wants none of
 * them) purely to reach one button. Rendering ``MusicControl`` next to
 * the existing player is the smaller coherent change: one new strip,
 * the same ``useReplayMusic`` hook, the same ``MusicControl``.
 *
 * ONE CLOCK. ``useReplayMusic`` reads the playback time and speed (for
 * the battle swell and the loop rotation), so the score and the canvas
 * must not run separate clocks. This component holds the published
 * values and hands them straight back to ``MapReplayer`` through its
 * EXISTING optional controlled-playback props — no new props on the
 * replayer, and the canvas keeps advancing its own 60 fps ``timeRef``
 * and publishing at ~4 Hz exactly as it does under ``ReplayStage``.
 *
 * THE USER GESTURE. Browsers only let an AudioContext start inside a
 * user gesture. ``MapReplayer``'s Play button calls ``onPlayingChange``
 * SYNCHRONOUSLY from its click handler, so ``handlePlayingChange``
 * below still runs inside that gesture and can start the score. Audio
 * must never be started from an effect reacting to ``playing`` — by the
 * time an effect runs the gesture is over and the context stays
 * suspended. This mirrors what ``ReplayStage`` does with the transport
 * dock's click.
 */

import { useCallback, useState } from "react";
import type { MapPlayback } from "@/lib/mapReplay";
import { useReplayMusic } from "@/lib/replayMusic";
import { MapReplayer } from "../MapReplayer";
import { MusicControl } from "./MusicControl";
import type { ReplaySpeed } from "./TransportDock";

export function CompactReplayHost({
  playback,
  gameId,
  myRace,
  maxHeightPx,
}: {
  playback: MapPlayback;
  /** Seeds the score so one game always draws the same track. */
  gameId?: string | null;
  myRace?: string | null;
  maxHeightPx?: number;
}) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(8);

  const music = useReplayMusic({ playback, gameId, myRace, time, speed });
  const { setPlaying: setMusicPlaying } = music;

  // Echoed back to MapReplayer VERBATIM — it compares by identity to
  // tell its own 4 Hz tick apart from an external seek.
  const handleTimeChange = useCallback((next: number) => setTime(next), []);
  const handlePlayingChange = useCallback(
    (next: boolean) => {
      // Synchronous, still inside the replayer's play/pause click.
      setMusicPlaying(next);
      setPlaying(next);
    },
    [setMusicPlaying],
  );
  const handleSpeedChange = useCallback((next: ReplaySpeed) => setSpeed(next), []);

  return (
    <>
      <div
        data-testid="replay-compact-controls"
        className="flex items-center justify-end gap-2"
      >
        <MusicControl music={music} />
      </div>
      <MapReplayer
        playback={playback}
        maxHeightPx={maxHeightPx}
        time={time}
        onTimeChange={handleTimeChange}
        playing={playing}
        onPlayingChange={handlePlayingChange}
        speed={speed}
        onSpeedChange={handleSpeedChange}
      />
    </>
  );
}
