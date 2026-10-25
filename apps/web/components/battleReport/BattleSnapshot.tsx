"use client";

import type { MacroBreakdownData } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import type { SnapshotMoment } from "@/lib/battleReport/facts";
import type { MapPlayback } from "@/lib/mapReplay";
import { formatGameClock } from "@/lib/macro";
import { MapStill } from "./MapStill";
import { ArmySnapshot } from "./ArmySnapshot";
import { snapshotRace } from "./snapshotRace";

export function BattleSnapshot({ moment, playback, breakdown, duration, segmented = false, myRace, oppRace, onSeek }: {
  moment: SnapshotMoment; playback?: MapPlayback | null; breakdown?: MacroBreakdownData | null; duration: number | null; segmented?: boolean; myRace?: string | null; oppRace?: string | null; onSeek: (time: number) => void;
}) {
  const clock = formatGameClock(moment.time);
  const mine = snapshotRace(myRace, "me"), theirs = snapshotRace(oppRace, "opp");
  const frame = playback && moment.time <= playback.gameLength ? playback : null;
  return <figure className="min-w-0 overflow-hidden rounded-lg border border-border bg-bg-surface">
    <button type="button" aria-label={`Seek replay to ${clock}: ${moment.caption}`} onClick={() => onSeek(moment.time)} className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
      {frame ? <MapStill playback={frame} moment={moment} myRace={myRace} oppRace={oppRace} /> : <ArmySnapshot time={moment.time} duration={duration} mine={breakdown?.stats_events} opponent={breakdown?.opp_stats_events} />}
      <span className="flex flex-wrap items-start justify-between gap-2 px-3 pt-3 text-caption font-semibold text-text"><span>{moment.caption}</span><span className="font-mono tabular-nums text-accent">{clock}</span></span>
    </button>
    <figcaption className="space-y-1 px-3 pb-3 pt-1 text-micro text-text-muted">{frame ? <><p><span style={{ color: `rgb(var(${mine.token}))` }}>You · {mine.name} · solid</span>{" / "}<span style={{ color: `rgb(var(${theirs.token}))` }}>Opponent · {theirs.name} · outline</span></p><p>Units are dots; structures are squares.</p>{frame.fidelity?.positions !== "engine" ? <p>Replay positions may be approximate.</p> : null}</> : <><p>You in cyan · Opponent in red</p><p>Recorded army-value samples appear when available. {playback ? "The map recording does not cover this time." : segmented ? "Seek the replay to view this moment on the map." : "Map snapshots need map data synced by the desktop app."}</p></>}</figcaption>
  </figure>;
}
