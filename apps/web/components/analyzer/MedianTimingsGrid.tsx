"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { wrColor } from "@/lib/format";
import { buildingDisplayName } from "@/lib/timingCatalog";

export type TimingSample = {
  seconds: number;
  display: string;
  date: string;
  map: string;
  won: boolean;
  result: string;
  gameId?: string | null;
  oppRace?: string;
  myRace?: string;
};

export type TimingInfo = {
  sampleCount: number;
  medianSeconds: number | null;
  medianDisplay: string;
  p25Seconds: number | null;
  p25Display: string;
  p75Seconds: number | null;
  p75Display: string;
  minSeconds: number | null;
  minDisplay: string;
  maxSeconds: number | null;
  maxDisplay: string;
  lastSeenSeconds: number | null;
  lastSeenDisplay: string;
  winRateWhenBuilt: number | null;
  trend: "earlier" | "later" | "stable" | "unknown";
  source: "build_log" | "opp_build_log";
  samples: TimingSample[];
  displayName?: string;
  iconFile?: string;
};

export type MatchupTimings = {
  timings: Record<string, TimingInfo>;
  order: string[];
};

const SF_KEY = "analyzer.timings.sourceFilter";
const MS_KEY = "analyzer.timings.matchup";

const TREND_GLYPHS: Record<
  TimingInfo["trend"],
  { glyph: string; label: string; color: string }
> = {
  earlier: { glyph: "↓", label: "trending earlier", color: "#3ec07a" },
  later: { glyph: "↑", label: "trending later", color: "#ff9d6c" },
  stable: { glyph: "→", label: "stable", color: "#9aa3b2" },
  unknown: { glyph: "·", label: "not enough samples", color: "#5a6478" },
};

/**
 * Matchup-aware Median Timings grid. Mirrors the legacy SPA card —
 * matchup chips on top, source filter (Both / Opponent's tech / Your
 * tech), and a click-to-drilldown panel listing every contributing
 * game for a token.
 */
export function MedianTimingsGrid({
  timings,
  order,
  matchupLabel,
  matchupCounts,
  matchupTimings,
  opponentName,
  onOpenGame,
}: {
  timings: Record<string, TimingInfo>;
  order: string[];
  matchupLabel: string;
  matchupCounts: Record<string, number>;
  matchupTimings: Record<string, MatchupTimings>;
  opponentName: string;
  onOpenGame?: (gameId: string) => void;
}) {
  const [sourceFilter, setSourceFilter] = useState<"both" | "opp" | "self">(
    () => readLocal(SF_KEY) === "opp" || readLocal(SF_KEY) === "self"
      ? (readLocal(SF_KEY) as "opp" | "self")
      : "both",
  );
  useEffect(() => {
    writeLocal(SF_KEY, sourceFilter);
  }, [sourceFilter]);

  const matchupChips = useMemo(
    () =>
      matchupCounts
        ? Object.entries(matchupCounts).sort(
            ([, a], [, b]) => (b as number) - (a as number),
          )
        : [],
    [matchupCounts],
  );

  const opponentKey = opponentName || matchupLabel || "__none__";
  const [activeMatchup, setActiveMatchup] = useState<string>(() => {
    const raw = readLocal(MS_KEY);
    try {
      const obj = raw ? JSON.parse(raw) : null;
      const stored = obj && obj[opponentKey];
      if (stored === "All" || stored == null) return "All";
      if (matchupCounts && matchupCounts[stored]) return stored;
      return "All";
    } catch {
      return "All";
    }
  });
  useEffect(() => {
    try {
      const raw = readLocal(MS_KEY);
      const obj = raw ? JSON.parse(raw) : {};
      obj[opponentKey] = activeMatchup;
      writeLocal(MS_KEY, JSON.stringify(obj));
    } catch {
      /* private mode */
    }
  }, [activeMatchup, opponentKey]);

  let activeTimings = timings;
  let activeOrder = order;
  let activeLabel = matchupLabel;
  if (
    activeMatchup !== "All" &&
    matchupTimings &&
    matchupTimings[activeMatchup]
  ) {
    activeTimings = matchupTimings[activeMatchup].timings;
    activeOrder = matchupTimings[activeMatchup].order;
    activeLabel = activeMatchup;
  }

  const [drillToken, setDrillToken] = useState<string | null>(null);

  if (!activeTimings || !activeOrder || activeOrder.length === 0) {
    return (
      <EmptyState
        title="No matchup-relevant timings"
        sub="This opponent has no games with both build logs parsed yet."
      />
    );
  }

  const visibleTokens = activeOrder.filter((tok) => {
    const info = activeTimings[tok];
    if (!info) return false;
    if (sourceFilter === "opp") return info.source === "opp_build_log";
    if (sourceFilter === "self") return info.source === "build_log";
    return true;
  });

  const total = activeOrder.length;
  const filterSuffix =
    sourceFilter === "opp"
      ? " — opponent tech only"
      : sourceFilter === "self"
        ? " — your tech only"
        : "";
  const matchupSuffix =
    activeMatchup === "All"
      ? ""
      : ` (${(matchupCounts && matchupCounts[activeMatchup]) || 0} game${
          (matchupCounts && matchupCounts[activeMatchup]) === 1 ? "" : "s"
        })`;
  const summary = activeLabel
    ? `Showing ${visibleTokens.length} of ${total} timings for ${activeLabel}${matchupSuffix}${filterSuffix}`
    : `Showing ${visibleTokens.length} of ${total} timings${filterSuffix}`;

  return (
    <div data-testid="median-timings-grid">
      {matchupChips.length > 0 ? (
        <div
          className="mb-2 flex flex-wrap items-center gap-2"
          data-testid="median-timings-matchup-chips"
        >
          <PillButton
            active={activeMatchup === "All"}
            onClick={() => setActiveMatchup("All")}
          >
            All
          </PillButton>
          {matchupChips.map(([ml, n]) => (
            <PillButton
              key={ml}
              active={activeMatchup === ml}
              onClick={() => setActiveMatchup(ml)}
            >
              {`${ml} (${n})`}
            </PillButton>
          ))}
        </div>
      ) : null}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <PillButton
          active={sourceFilter === "both"}
          onClick={() => setSourceFilter("both")}
        >
          Both
        </PillButton>
        <PillButton
          active={sourceFilter === "opp"}
          onClick={() => setSourceFilter("opp")}
        >
          Opponent's tech
        </PillButton>
        <PillButton
          active={sourceFilter === "self"}
          onClick={() => setSourceFilter("self")}
        >
          Your tech
        </PillButton>
      </div>
      <div
        aria-live="polite"
        className="mb-2 text-[11px] text-text-dim"
        data-testid="median-timings-summary"
      >
        {summary}
      </div>
      {visibleTokens.length === 0 ? (
        <EmptyState
          title="No timings for this filter"
          sub="Try the other source pill or 'Both'."
        />
      ) : (
        <div
          className="grid gap-2"
          style={{
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
          }}
        >
          {visibleTokens.map((tok) => (
            <TimingCard
              key={tok}
              token={tok}
              info={activeTimings[tok]}
              onClick={() => {
                if ((activeTimings[tok] || {}).sampleCount > 0) {
                  setDrillToken(tok);
                }
              }}
            />
          ))}
        </div>
      )}
      <TimingsDrilldownDrawer
        open={!!drillToken}
        onClose={() => setDrillToken(null)}
        token={drillToken}
        info={drillToken ? activeTimings[drillToken] : null}
        matchupLabel={activeLabel}
        onOpenGame={onOpenGame}
      />
    </div>
  );
}

function TimingCard({
  token,
  info,
  onClick,
}: {
  token: string;
  info: TimingInfo | undefined;
  onClick: () => void;
}) {
  const i = info || ({} as TimingInfo);
  const empty = !i.sampleCount;
  const display = i.displayName || buildingDisplayName(token, token);
  const trend = TREND_GLYPHS[i.trend] || TREND_GLYPHS.unknown;
  const wrPctStr =
    i.winRateWhenBuilt == null
      ? "—"
      : `${Math.round(i.winRateWhenBuilt * 100)}%`;
  const wrPillBg = wrColor(i.winRateWhenBuilt, i.sampleCount || 0);
  // Icon resolution: prefer the explicit iconFile from the API
  // payload, fall back to the token (which is already capitalized
  // like "Cybernetics" or "RoboticsFacility" — Icon's normalizer
  // handles either).
  const iconName = (i.iconFile || "").replace(/\.png$/i, "") || token;

  return (
    <div
      role={empty ? undefined : "button"}
      tabIndex={empty ? -1 : 0}
      aria-label={empty ? `${display} — no samples` : `${display}, median ${i.medianDisplay}`}
      aria-disabled={empty || undefined}
      onClick={empty ? undefined : onClick}
      onKeyDown={
        empty
          ? undefined
          : (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
      }
      className={
        "rounded-lg border border-border bg-bg-elevated px-3 py-2 transition " +
        (empty
          ? "cursor-default opacity-60"
          : "cursor-pointer hover:bg-bg-elevated/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent")
      }
      data-testid="timing-card"
      data-token={token}
      data-empty={empty ? "1" : "0"}
      data-source={i.source || ""}
    >
      <div className="flex items-start gap-2">
        <Icon
          name={iconName}
          kind="building"
          size={32}
          decorative
          className={empty ? "opacity-50" : ""}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] uppercase tracking-wider text-text-dim">
            {display}
          </div>
          <div
            className={
              "mt-0.5 text-xl font-semibold tabular-nums " +
              (empty ? "text-text-dim" : "text-text")
            }
          >
            {i.medianDisplay || "-"}
          </div>
        {!empty && i.sampleCount >= 2 && i.p25Display && i.p75Display ? (
          <div className="text-[10px] tabular-nums text-text-dim">
            {i.p25Display} — {i.p75Display}
          </div>
        ) : empty ? (
          <div className="text-[10px] text-text-dim">no samples</div>
        ) : (
          <div className="text-[10px] text-text-dim">single sample</div>
        )}
        </div>
      </div>
      <div className="mt-1 flex items-center gap-1 text-[10px]">
        <span className="tabular-nums text-text-dim">n={i.sampleCount || 0}</span>
        {!empty ? (
          <span
            className="rounded px-1.5 py-0.5 font-semibold"
            style={{ background: wrPillBg + "22", color: wrPillBg }}
            title={`win rate when built: ${wrPctStr}`}
          >
            {wrPctStr}
          </span>
        ) : null}
        <span
          className="ml-auto"
          aria-label={trend.label}
          title={trend.label}
          style={{ color: trend.color }}
        >
          {trend.glyph}
        </span>
      </div>
    </div>
  );
}

function TimingsDrilldownDrawer({
  open,
  onClose,
  token,
  info,
  matchupLabel,
  onOpenGame,
}: {
  open: boolean;
  onClose: () => void;
  token: string | null;
  info: TimingInfo | null;
  matchupLabel: string;
  onOpenGame?: (gameId: string) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !token || !info) return null;

  const samples = Array.isArray(info.samples) ? info.samples : [];
  const display = info.displayName || buildingDisplayName(token, token);
  const trend = TREND_GLYPHS[info.trend] || TREND_GLYPHS.unknown;
  const sourceLabel =
    info.source === "opp_build_log"
      ? "opponent's structures (sc2reader)"
      : "your build (proxy for matchup tendencies)";

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-label={`${display} — drilldown`}
      data-testid="timings-drilldown"
    >
      <div className="flex-1 bg-black/60" onClick={onClose} aria-hidden="true" />
      <aside
        ref={panelRef}
        className="flex h-full w-[min(560px,95vw)] flex-col border-l border-border bg-bg-surface"
      >
        <header className="flex items-center gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-text">
              {display}
            </div>
            <div className="truncate text-[11px] text-text-dim">
              {matchupLabel ? `${matchupLabel} · ` : ""}n={info.sampleCount} · median {info.medianDisplay}
              {info.p25Display && info.p75Display && info.sampleCount >= 2
                ? ` (${info.p25Display}–${info.p75Display})`
                : ""}
              {info.minDisplay && info.maxDisplay && info.sampleCount >= 2
                ? ` · range ${info.minDisplay}–${info.maxDisplay}`
                : ""}
            </div>
          </div>
          <span
            title={trend.label}
            aria-label={trend.label}
            style={{ color: trend.color }}
            className="text-base font-semibold tabular-nums"
          >
            {trend.glyph}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border px-2 py-1 text-xs uppercase tracking-wider text-text-muted hover:text-text"
            aria-label="Close drilldown"
          >
            Close
          </button>
        </header>
        <div className="border-b border-border px-5 py-3 text-[11px] text-text-dim">
          {sourceLabel} · sorted newest first
        </div>
        <div className="flex-1 overflow-y-auto" data-testid="timings-drilldown-list">
          {samples.length === 0 ? (
            <div className="p-6 text-center text-sm text-text-muted">
              No contributing games for this token.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {samples.map((s, i) => (
                <SampleRow
                  key={`${s.gameId || "g"}:${i}`}
                  sample={s}
                  source={info.source}
                  onOpenGame={onOpenGame}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

function SampleRow({
  sample,
  source,
  onOpenGame,
}: {
  sample: TimingSample;
  source: TimingInfo["source"];
  onOpenGame?: (gameId: string) => void;
}) {
  const isWin = sample.result === "Win" || sample.result === "Victory" || sample.won;
  const isLoss =
    sample.result === "Loss" ||
    sample.result === "Defeat" ||
    (!isWin && sample.won === false);
  const pillBg = isWin ? "#3ec07a" : isLoss ? "#ff6b6b" : "#9aa3b2";
  const canOpen = !!sample.gameId && typeof onOpenGame === "function";
  const onRowClick = canOpen ? () => onOpenGame?.(sample.gameId!) : undefined;
  const srcShort = source === "opp_build_log" ? "opp_log" : "my_log";

  return (
    <li
      role={canOpen ? "button" : undefined}
      tabIndex={canOpen ? 0 : -1}
      onClick={onRowClick}
      onKeyDown={
        canOpen
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onRowClick?.();
              }
            }
          : undefined
      }
      className={
        "px-5 py-3 hover:bg-bg-elevated/40 focus-within:bg-bg-elevated/40 " +
        (canOpen ? "cursor-pointer" : "")
      }
    >
      <div className="flex items-center gap-3 text-sm">
        <span className="w-12 font-mono tabular-nums text-text">
          {sample.display}
        </span>
        <span
          className="flex-1 truncate text-text-muted"
          title={sample.map || ""}
        >
          {sample.map || "—"}
        </span>
        <span className="font-mono text-xs text-text-dim">
          {(sample.myRace || "?")[0]?.toUpperCase()}
        </span>
        <span className="text-xs text-text-dim">vs</span>
        <span className="font-mono text-xs text-text-dim">
          {(sample.oppRace || "?")[0]?.toUpperCase()}
        </span>
        <span
          className="rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white"
          style={{ background: pillBg }}
          title={isWin ? "Win" : isLoss ? "Loss" : "Result unknown"}
        >
          {isWin ? "W" : isLoss ? "L" : "?"}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-text-dim">
        <span title={sample.date} className="font-mono">
          {String(sample.date || "").slice(0, 10) || "—"}
        </span>
        <span className="flex items-center gap-2">
          <span
            className="rounded bg-bg-elevated px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
            title={
              source === "opp_build_log"
                ? "parsed from opponent's build log"
                : "parsed from your build log"
            }
          >
            {srcShort}
          </span>
          {canOpen ? (
            <span className="text-accent" aria-hidden="true">
              open game →
            </span>
          ) : null}
        </span>
      </div>
    </li>
  );
}

function PillButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "rounded-full border px-3 py-1 text-xs transition " +
        (active
          ? "border-accent bg-accent/15 text-accent"
          : "border-border bg-bg-elevated text-text-muted hover:text-text")
      }
    >
      {children}
    </button>
  );
}

function readLocal(key: string): string | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}
