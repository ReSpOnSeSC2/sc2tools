"use client";

import { useMemo } from "react";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import type { MacroBreakdownData } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import {
  computeEffectiveRace,
  formatGameClock,
  getRaceDetail,
  scoreToneTextClass,
  tierFromSq,
} from "@/lib/macro";
import type { GameSummary } from "./types";

export interface MechanicsPanelProps {
  breakdown?: MacroBreakdownData | null;
  game?: GameSummary | null;
  loading?: boolean;
  /** Scrubs the timeline — supply-block window chips jump the cursor. */
  onSeek?: (timeSec: number) => void;
}

/**
 * MechanicsPanel — the community-vocabulary macro stats for one game:
 * SQ (Spending Quotient), supply-blocked time + windows, the race
 * mechanic (injects / chronos / MULEs) actual-vs-expected with a small
 * bar, and mineral float. Labels are race-aware via lib/macro's
 * RaceMeta so a Zerg game says "Injects" and a Terran game "MULEs".
 *
 * Degrades: with no breakdown at all it shows an explanatory empty
 * state; individual stats hide when their fields are absent (slim /
 * pre-v0.5 payloads).
 */
export function MechanicsPanel({
  breakdown,
  game,
  loading,
  onSeek,
}: MechanicsPanelProps) {
  const raw = breakdown?.raw;
  const race = computeEffectiveRace(breakdown?.race ?? game?.myRace, raw);
  const raceDetail = getRaceDetail(race);

  const sq = useMemo(() => {
    if (typeof raw?.sq === "number") return raw.sq;
    if (typeof breakdown?.player_stats?.me?.spq === "number") {
      return breakdown.player_stats.me.spq;
    }
    if (typeof game?.spq === "number") return game.spq;
    return null;
  }, [raw, breakdown, game]);

  const macroScore =
    typeof game?.macroScore === "number"
      ? game.macroScore
      : typeof breakdown?.macro_score === "number"
        ? breakdown.macro_score
        : null;

  const supplyBlockedSec = useMemo(() => {
    const windows = raw?.supply_block_windows;
    if (Array.isArray(windows) && windows.length > 0) {
      let total = 0;
      for (const w of windows) {
        if (typeof w?.start !== "number" || typeof w?.end !== "number") continue;
        total +=
          typeof w.blocked_sec === "number"
            ? w.blocked_sec
            : Math.max(0, w.end - w.start);
      }
      if (total > 0) return Math.round(total);
    }
    return typeof raw?.supply_blocked_seconds === "number"
      ? Math.round(raw.supply_blocked_seconds)
      : null;
  }, [raw]);

  const supplyWindows = Array.isArray(raw?.supply_block_windows)
    ? raw.supply_block_windows.filter(
        (w) => typeof w?.start === "number" && typeof w?.end === "number",
      )
    : [];

  const mechanicActual =
    raceDetail && typeof raw?.[raceDetail.actualKey] === "number"
      ? (raw[raceDetail.actualKey] as number)
      : null;
  const mechanicExpected =
    raceDetail && typeof raw?.[raceDetail.expectedKey] === "number"
      ? (raw[raceDetail.expectedKey] as number)
      : null;

  const floatSpikes =
    typeof raw?.mineral_float_spikes === "number"
      ? raw.mineral_float_spikes
      : null;

  if (loading) {
    return (
      <Card title="Mechanics">
        <div className="space-y-2" aria-busy="true" aria-label="Loading mechanics">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-5 animate-pulse rounded bg-bg-elevated" />
          ))}
        </div>
      </Card>
    );
  }

  const hasAnything =
    sq !== null ||
    macroScore !== null ||
    supplyBlockedSec !== null ||
    mechanicActual !== null ||
    floatSpikes !== null;

  if (!breakdown && !hasAnything) {
    return (
      <Card title="Mechanics">
        <EmptyStatePanel
          size="sm"
          title="No macro breakdown for this game"
          description="Ask the desktop agent to recompute (Macro tab → backfill) and this panel fills in."
        />
      </Card>
    );
  }

  const sqTier = tierFromSq(sq);

  return (
    <Card title="Mechanics" data-testid="mechanics-panel">
      <dl className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <MechanicStat
            label="Macro score"
            value={macroScore !== null ? Math.round(macroScore) : "—"}
            valueClass={scoreToneTextClass(macroScore)}
          />
          <MechanicStat
            label="SQ (Spending Quotient)"
            value={sq !== null ? Math.round(sq) : "—"}
            hint={sqTier ? `${sqTier}-tier spending` : undefined}
          />
        </div>

        <div>
          <dt className="text-micro uppercase tracking-wider text-text-dim">
            Supply blocked
          </dt>
          <dd className="mt-1">
            <span
              className={`text-lg font-semibold tabular-nums ${
                supplyBlockedSec !== null && supplyBlockedSec >= 10
                  ? "text-danger"
                  : "text-text"
              }`}
            >
              {supplyBlockedSec !== null ? `${supplyBlockedSec}s` : "—"}
            </span>
            {supplyWindows.length > 0 ? (
              <span className="ml-2 text-caption text-text-muted">
                across {supplyWindows.length} window
                {supplyWindows.length === 1 ? "" : "s"}
              </span>
            ) : null}
            {supplyWindows.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {supplyWindows.slice(0, 8).map((w, i) => (
                  <button
                    key={`${w.start}-${i}`}
                    type="button"
                    onClick={onSeek ? () => onSeek(w.start) : undefined}
                    disabled={!onSeek}
                    aria-label={`Jump timeline to supply block at ${formatGameClock(w.start)}`}
                    className="inline-flex min-h-[32px] items-center rounded-full border border-border bg-bg-elevated px-2.5 font-mono text-micro tabular-nums text-text-muted transition-colors enabled:hover:border-border-strong enabled:hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default"
                  >
                    {formatGameClock(w.start)}–{formatGameClock(w.end)}
                  </button>
                ))}
              </div>
            ) : null}
          </dd>
        </div>

        {raceDetail && (mechanicActual !== null || mechanicExpected !== null) ? (
          <MechanicBar
            title={raceDetail.title}
            unitPlural={raceDetail.unitPlural}
            actual={mechanicActual}
            expected={mechanicExpected}
          />
        ) : null}

        <div>
          <dt className="text-micro uppercase tracking-wider text-text-dim">
            Mineral float
          </dt>
          <dd className="mt-1 text-caption text-text-muted">
            {floatSpikes === null ? (
              "—"
            ) : floatSpikes === 0 ? (
              <span className="text-success">
                No float spikes — the bank stayed spent.
              </span>
            ) : (
              <>
                <span className="font-semibold tabular-nums text-warning">
                  {floatSpikes}
                </span>{" "}
                sample{floatSpikes === 1 ? "" : "s"} with 800+ minerals banked
                after 4:00.
              </>
            )}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function MechanicStat({
  label,
  value,
  valueClass,
  hint,
}: {
  label: string;
  value: string | number;
  valueClass?: string;
  hint?: string;
}) {
  return (
    <div>
      <dt className="text-micro uppercase tracking-wider text-text-dim">
        {label}
      </dt>
      <dd className="mt-1">
        <span
          className={`text-lg font-semibold tabular-nums ${valueClass || "text-text"}`}
        >
          {value}
        </span>
        {hint ? (
          <span className="ml-2 text-micro text-text-muted">{hint}</span>
        ) : null}
      </dd>
    </div>
  );
}

/**
 * Actual-vs-expected mechanic bar. The full track is "expected"; the
 * filled portion is what the player actually did.
 */
function MechanicBar({
  title,
  unitPlural,
  actual,
  expected,
}: {
  title: string;
  unitPlural: string;
  actual: number | null;
  expected: number | null;
}) {
  const a = actual ?? 0;
  const e = expected ?? 0;
  const ratio = e > 0 ? Math.max(0, Math.min(1, a / e)) : 0;
  const pct = Math.round(ratio * 100);
  const toneClass =
    e <= 0 ? "bg-success" : ratio >= 0.85 ? "bg-success" : ratio >= 0.6 ? "bg-warning" : "bg-danger";
  return (
    <div>
      <dt className="text-micro uppercase tracking-wider text-text-dim">
        {title}
      </dt>
      <dd className="mt-1 space-y-1.5">
        <div className="flex items-baseline justify-between gap-2 text-caption">
          <span className="tabular-nums text-text">
            <span className="font-semibold">{actual ?? "—"}</span>
            <span className="text-text-dim"> / {expected ?? "—"} </span>
            {unitPlural}
          </span>
          {e > 0 ? (
            <span className="tabular-nums text-text-muted">{pct}%</span>
          ) : null}
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded bg-bg-elevated"
          role="img"
          aria-label={`${title}: ${a} of ${e} expected ${unitPlural} (${pct} percent)`}
        >
          <div
            className={`h-full rounded ${toneClass}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </dd>
    </div>
  );
}
