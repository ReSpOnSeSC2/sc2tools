"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, EmptyState } from "@/components/ui/Card";
import { Tabs } from "@/components/ui/Tabs";
import {
  chronological,
  decidedOnly,
  type Bucket,
  type H2HGame,
  type SplitMode,
} from "@/lib/h2hSeries";
import { useActivePresetLabels } from "./shared/presetLabel";
import {
  H2HHeader,
  bucketDisabledFor,
  inferBucketDefault,
} from "./H2HHeader";
import { MatchByMatchTimeline } from "./MatchByMatchTimeline";
import { StreaksMomentum } from "./StreaksMomentum";
import { MapPeriodHeatmap } from "./MapPeriodHeatmap";
import { BuildMatrix, type BuildMatchupSelection } from "./BuildMatrix";

type Props = {
  games: H2HGame[];
  oppRace?: string | null;
  opponentName: string;
  selectedMap: string | null;
  onSelectMap: (map: string | null) => void;
  selectedBuildMatchup: BuildMatchupSelection | null;
  onSelectBuildMatchup: (sel: BuildMatchupSelection | null) => void;
  onSelectGame: (gameId: string) => void;
};

type ViewId = "timeline" | "streaks" | "maps" | "builds";
const VALID_VIEWS: ReadonlySet<string> = new Set([
  "timeline",
  "streaks",
  "maps",
  "builds",
]);

const LS_BUCKET = "analyzer.h2h.bucket";
const LS_ROLLING = "analyzer.h2h.rolling";
const LS_SPLIT = "analyzer.h2h.split";
const LS_MATRIX = "analyzer.h2h.matrixSize";

const ROLLING_OPTIONS = [3, 5, 10, 20] as const;
const HASH_PREFIX = "#h2h=";

function readLs<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(key);
    if (v == null) return fallback;
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

function writeLs(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* non-fatal */
  }
}

/**
 * H2H Trends section. Shell that wires URL-hash tab state, the
 * shared bucket/rolling/split/matrix-size controls, and the four
 * underlying views. All four views read from the same in-memory
 * games array — no extra fetch is issued by switching tabs.
 */
export function H2HTrendsSection({
  games,
  oppRace,
  opponentName,
  selectedMap,
  onSelectMap,
  selectedBuildMatchup,
  onSelectBuildMatchup,
  onSelectGame,
}: Props) {
  const presetLabels = useActivePresetLabels();
  // Initial render must match SSR — read the URL hash after mount.
  // Until then, default to "timeline".
  const [view, setView] = useState<ViewId>("timeline");
  useEffect(() => {
    const fromHash = readHashView();
    if (fromHash !== view) setView(fromHash);
    // run once on mount; intentional empty deps
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [bucket, setBucket] = useState<Bucket>(() =>
    inferBucketDefault(
      presetLabels.presetId,
      computeSpanDays(games),
      readLs<Bucket | null>(LS_BUCKET, null),
    ),
  );
  const [rollingWindow, setRollingWindow] = useState<number>(() => {
    const stored = readLs<number>(LS_ROLLING, 5);
    return ROLLING_OPTIONS.includes(stored as 3 | 5 | 10 | 20) ? stored : 5;
  });
  const [split, setSplit] = useState<SplitMode>(() => {
    const v = readLs<string>(LS_SPLIT, "halves");
    return v === "thirds" ? "thirds" : "halves";
  });
  const [matrixSize, setMatrixSize] = useState<5 | 10 | "all">(() => {
    const v = readLs<5 | 10 | "all">(LS_MATRIX, 5);
    if (v === 5 || v === 10 || v === "all") return v;
    return 5;
  });

  useEffect(() => writeLs(LS_BUCKET, bucket), [bucket]);
  useEffect(() => writeLs(LS_ROLLING, rollingWindow), [rollingWindow]);
  useEffect(() => writeLs(LS_SPLIT, split), [split]);
  useEffect(() => writeLs(LS_MATRIX, matrixSize), [matrixSize]);

  // URL hash sync — reflect the active view, also listen for back/
  // forward navigation that changes the hash externally.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash !== `${HASH_PREFIX}${view}`) {
      const url = new URL(window.location.href);
      url.hash = `${HASH_PREFIX}${view}`;
      window.history.replaceState(null, "", url);
    }
  }, [view]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onHash = () => setView(readHashView());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Bucket guard: when the active preset disables the chosen bucket,
  // snap to the most permissive remaining option without losing the
  // user's preference for unrelated presets.
  const bucketDisabled = useMemo(
    () => bucketDisabledFor(presetLabels.presetId),
    [presetLabels.presetId],
  );
  useEffect(() => {
    if (bucket === "month" && bucketDisabled.month) setBucket("week");
    else if (bucket === "week" && bucketDisabled.week) setBucket("day");
  }, [bucket, bucketDisabled]);

  const chrono = useMemo(() => chronological(games), [games]);
  const decidedCount = useMemo(() => decidedOnly(chrono).length, [chrono]);

  // Rolling window must not exceed the available decided games. Snap
  // down silently when the window shrinks (preset change clears the
  // history); the user's stored preference comes back as soon as
  // there's enough data.
  const allowedRolling = useMemo(
    () =>
      ROLLING_OPTIONS.filter((n) => n <= Math.max(2, Math.min(20, decidedCount))),
    [decidedCount],
  );
  const effectiveRolling = useMemo(() => {
    if (allowedRolling.includes(rollingWindow as 3 | 5 | 10 | 20)) {
      return rollingWindow;
    }
    return allowedRolling.length > 0 ? allowedRolling[allowedRolling.length - 1] : 3;
  }, [allowedRolling, rollingWindow]);

  const isTimelineView = view === "timeline";

  const noDecidedGames = decidedCount === 0;

  return (
    <Card title="H2H trends">
      <div className="space-y-4">
        <H2HHeader
          presetLabels={presetLabels}
          bucket={bucket}
          setBucket={setBucket}
          bucketDisabled={bucketDisabled}
          rollingWindow={effectiveRolling}
          setRollingWindow={setRollingWindow}
          rollingOptions={[...allowedRolling]}
          showBucketAndRolling={isTimelineView}
        />

        {noDecidedGames ? (
          <EmptyState
            title="No games to chart"
            sub={`No games vs ${opponentName} in ${presetLabels.long}.`}
          />
        ) : (
          <Tabs value={view} onValueChange={(v) => setView(v as ViewId)}>
            <Tabs.List ariaLabel="H2H view">
              <Tabs.Trigger value="timeline">Timeline</Tabs.Trigger>
              <Tabs.Trigger value="streaks">Streaks</Tabs.Trigger>
              <Tabs.Trigger value="maps">Maps</Tabs.Trigger>
              <Tabs.Trigger value="builds">Builds</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="timeline" className="min-h-[260px]">
              <MatchByMatchTimeline
                chronoGames={chrono}
                oppRace={oppRace}
                bucket={bucket}
                rollingWindow={effectiveRolling}
                presetLong={presetLabels.long}
                opponentName={opponentName}
                onSelectGame={onSelectGame}
              />
            </Tabs.Content>
            <Tabs.Content value="streaks" className="min-h-[260px]">
              <StreaksMomentum
                chronoGames={chrono}
                presetShort={presetLabels.short}
                presetLong={presetLabels.long}
                opponentName={opponentName}
                onSelectGame={onSelectGame}
              />
            </Tabs.Content>
            <Tabs.Content value="maps" className="min-h-[260px]">
              <MapPeriodHeatmap
                chronoGames={chrono}
                split={split}
                onSplitChange={setSplit}
                onSelectMap={onSelectMap}
                selectedMap={selectedMap}
                presetLong={presetLabels.long}
                opponentName={opponentName}
              />
            </Tabs.Content>
            <Tabs.Content value="builds" className="min-h-[260px]">
              <BuildMatrix
                chronoGames={chrono}
                matrixSize={matrixSize}
                onMatrixSizeChange={setMatrixSize}
                selected={selectedBuildMatchup}
                onSelect={onSelectBuildMatchup}
                presetLong={presetLabels.long}
                opponentName={opponentName}
              />
            </Tabs.Content>
          </Tabs>
        )}
      </div>
    </Card>
  );
}

function readHashView(): ViewId {
  if (typeof window === "undefined") return "timeline";
  const raw = window.location.hash || "";
  if (!raw.startsWith(HASH_PREFIX)) return "timeline";
  const v = raw.slice(HASH_PREFIX.length);
  return VALID_VIEWS.has(v) ? (v as ViewId) : "timeline";
}

function computeSpanDays(games: H2HGame[]): number {
  let earliest: number | null = null;
  let latest: number | null = null;
  for (const g of games) {
    if (!g.date) continue;
    const t = new Date(g.date).getTime();
    if (!Number.isFinite(t)) continue;
    if (earliest == null || t < earliest) earliest = t;
    if (latest == null || t > latest) latest = t;
  }
  if (earliest == null || latest == null) return 0;
  return Math.max(0, Math.round((latest - earliest) / 86_400_000));
}
