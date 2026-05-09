"use client";

import { useEffect, useState } from "react";
import { Radio } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { useLiveGame } from "@/lib/useLiveGame";

/**
 * Dashboard "live game in progress" card.
 *
 * Subscribes to the cloud's per-user SSE stream (``GET /v1/me/live``)
 * via the ``useLiveGame`` hook and renders a compact status panel
 * whenever the desktop agent has emitted a non-idle envelope in the
 * recent past.
 *
 * Auto-hides:
 *   * when the bridge reports ``idle`` / ``menu`` (the hook clears
 *     the envelope), or
 *   * when more than ``STALE_MS`` ms have passed since the last
 *     envelope, even if the connection is still open. A genuinely-
 *     in-progress match emits at 1 Hz, so a 30 s gap means the agent
 *     either crashed or the cloud went quiet — either way the panel
 *     should vanish rather than pin a stale opponent.
 *
 * Live elapsed-time timer:
 *   ``displayTime`` carries the SC2 in-game clock (seconds), which
 *   ticks at SC2's "Faster" cadence (~1.4× wall clock). The panel
 *   surfaces it directly so the streamer sees the same clock the game
 *   shows. Between envelopes we extrapolate forward 1 s/sec so the
 *   number doesn't sit frozen between ticks.
 */
const STALE_MS = 30_000;

export function LiveGamePanel() {
  const { live, lastUpdatedAt } = useLiveGame();
  const stale = useStaleAfter(lastUpdatedAt, STALE_MS);
  // All hooks must run unconditionally — extrapolate even when we're
  // about to render nothing so React doesn't see the hook count change
  // between renders. The only added cost is one cheap interval that's
  // mounted alongside the panel.
  const elapsed = useExtrapolatedDisplayTime(
    live?.displayTime ?? null,
    lastUpdatedAt,
  );
  if (!live || stale) return null;

  const oppName = live.opponent?.name?.trim() || null;
  const oppRace = live.opponent?.race?.trim() || null;
  const profile = live.opponent?.profile;
  const mmr =
    profile && typeof profile.mmr === "number" && profile.mmr > 0
      ? profile.mmr
      : null;
  const league = profile?.league?.trim() || null;
  const phaseLabel = formatPhase(live.phase);

  return (
    <Card variant="elevated" padded>
      <div className="flex flex-wrap items-center gap-3">
        <span
          className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-accent-cyan/20 text-accent-cyan"
          aria-hidden
        >
          <Radio className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-body font-semibold text-text">
            Live game{" "}
            {oppName ? (
              <>
                vs <span className="text-accent-cyan">{oppName}</span>
              </>
            ) : (
              "in progress"
            )}
            {oppRace ? (
              <span className="text-text-muted"> ({formatRace(oppRace)})</span>
            ) : null}
          </div>
          <div className="text-caption text-text-muted">
            {phaseLabel}
            {elapsed !== null ? (
              <>
                {" · "}
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                  {formatElapsed(elapsed)}
                </span>
              </>
            ) : null}
            {mmr !== null ? (
              <>
                {" · "}
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                  {mmr} MMR
                </span>
              </>
            ) : null}
            {league ? <> · {league}</> : null}
          </div>
        </div>
      </div>
    </Card>
  );
}

/**
 * Returns ``true`` when ``lastUpdatedAt`` is older than ``maxAgeMs``.
 * Re-renders every second so the staleness flip happens promptly
 * without holding the full render of the parent on a setState.
 */
function useStaleAfter(
  lastUpdatedAt: number | null,
  maxAgeMs: number,
): boolean {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (lastUpdatedAt === null) return true;
  return now - lastUpdatedAt > maxAgeMs;
}

/**
 * Extrapolate the in-game clock forward between envelopes so the
 * displayed elapsed time isn't visibly frozen for the ~1 s gap
 * between agent ticks. Returns ``null`` when no displayTime has been
 * received yet.
 */
function useExtrapolatedDisplayTime(
  displayTime: number | null,
  baselineMs: number | null,
): number | null {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (displayTime === null || baselineMs === null) return null;
  // Wall-clock deltas in seconds. SC2 reports ``displayTime`` already
  // in the game's faster-than-realtime clock, so extrapolating with a
  // 1:1 ratio between ticks is close enough — the agent's next tick
  // (≤1 s away) will correct any drift.
  const deltaSec = Math.max(0, (now - baselineMs) / 1000);
  return displayTime + deltaSec;
}

function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatPhase(phase: string): string {
  switch (phase) {
    case "match_loading":
      return "Loading screen";
    case "match_started":
      return "Match started";
    case "match_in_progress":
      return "In progress";
    case "match_ended":
      return "Match ending — replay parsing soon";
    default:
      return phase;
  }
}

function formatRace(race: string): string {
  const r = race.trim().toLowerCase();
  if (r === "terran") return "Terran";
  if (r === "zerg") return "Zerg";
  if (r === "protoss") return "Protoss";
  if (r === "random") return "Random";
  return race;
}
