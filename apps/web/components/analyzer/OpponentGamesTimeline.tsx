"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import type { PerGameScoutingEnvelope } from "@/components/overlay/types";

/**
 * "How games against this opponent play out" — per-game replay
 * timeline. Renders the same real-data envelope the overlay's
 * scouting widget consumes (per-game build orders, per-phase
 * composition snapshots, classifier-derived phase transitions, real
 * end-phase + end-reason), then lets the user tab through every game
 * the API returned so each replay shows up as its own card.
 *
 * The component is intentionally read-only and self-contained — no
 * API calls, no client-side aggregation. Every value displayed comes
 * from a single ``PerGameScoutingEnvelope`` produced server-side by
 * ``computePerGameScouting``.
 */

type Phase = "early" | "earlyMid" | "mid" | "midLate" | "late";

const PHASE_ORDER: Phase[] = ["early", "earlyMid", "mid", "midLate", "late"];
const PHASE_LABEL: Record<Phase, string> = {
  early: "Early",
  earlyMid: "Early/Mid",
  mid: "Mid",
  midLate: "Mid/Late",
  late: "Late",
};
const PHASE_SHORT: Record<Phase, string> = {
  early: "Early",
  earlyMid: "E/Mid",
  mid: "Mid",
  midLate: "M/Late",
  late: "Late",
};
const PHASE_DIST_COLOR: Record<Phase, string> = {
  early: "rgb(var(--danger))",
  earlyMid: "rgb(var(--warning))",
  mid: "rgb(var(--accent))",
  midLate: "rgb(var(--accent-cyan))",
  late: "rgb(var(--success))",
};

const END_REASON_LABEL: Record<PerGameScoutingEnvelope["endReason"], string> = {
  early_allin: "All-in",
  early_loss: "Early loss",
  early_win: "Early win",
  midgame_engagement: "Mid-game engagement",
  macro_game: "Macro game",
  unknown: "Outcome unclear",
};

const BUILD_ORDER_GROUP_GAP_SEC = 10;
const MAX_BUILD_ORDER_EVENTS = 18;

export interface OpponentGamesTimelineProps {
  envelopes: PerGameScoutingEnvelope[];
  finalPhaseDistribution?: Partial<Record<Phase, number>>;
  sampleSize?: Partial<Record<Phase, number>>;
}

export function OpponentGamesTimeline({
  envelopes,
  finalPhaseDistribution,
  sampleSize,
}: OpponentGamesTimelineProps) {
  const games = useMemo(
    () => envelopes.filter(Boolean),
    [envelopes],
  );
  const [activeIdx, setActiveIdx] = useState(0);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const activeBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (activeIdx >= games.length) setActiveIdx(0);
  }, [activeIdx, games.length]);

  useEffect(() => {
    // Scroll the active chip into view when the user moves between games
    // via the arrow buttons or keyboard. Guarded for jsdom (test env)
    // where scrollIntoView isn't implemented.
    const node = activeBtnRef.current;
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({
        block: "nearest",
        inline: "center",
        behavior: "smooth",
      });
    }
  }, [activeIdx]);

  const onKey = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIdx((i) => Math.min(games.length - 1, i + 1));
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
      } else if (event.key === "Home") {
        event.preventDefault();
        setActiveIdx(0);
      } else if (event.key === "End") {
        event.preventDefault();
        setActiveIdx(games.length - 1);
      }
    },
    [games.length],
  );

  if (games.length === 0) return null;
  const active = games[activeIdx] ?? games[0];

  return (
    <div className="space-y-4">
      <FinalPhaseDistribution
        finalPhaseDistribution={finalPhaseDistribution}
        sampleSize={sampleSize}
        totalGames={games.length}
      />

      <div
        className="flex items-center gap-2"
        role="tablist"
        aria-label="Per-game timeline"
        onKeyDown={onKey}
      >
        <NavButton
          direction="prev"
          disabled={activeIdx === 0}
          onClick={() => setActiveIdx((i) => Math.max(0, i - 1))}
        />
        <div
          ref={stripRef}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pb-1"
          data-testid="opponent-games-strip"
        >
          {games.map((env, i) => (
            <GameTab
              key={env.gameId || `${env.date}-${i}`}
              envelope={env}
              index={games.length - i}
              isActive={i === activeIdx}
              onSelect={() => setActiveIdx(i)}
              btnRef={i === activeIdx ? activeBtnRef : undefined}
            />
          ))}
        </div>
        <NavButton
          direction="next"
          disabled={activeIdx === games.length - 1}
          onClick={() =>
            setActiveIdx((i) => Math.min(games.length - 1, i + 1))
          }
        />
      </div>

      <div className="text-caption text-text-dim">
        Game {games.length - activeIdx} of {games.length} · use arrow keys
        to step through replays
      </div>

      <GameDetailCard envelope={active} />
    </div>
  );
}

function NavButton({
  direction,
  disabled,
  onClick,
}: {
  direction: "prev" | "next";
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon_ = direction === "prev" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={direction === "prev" ? "Previous game" : "Next game"}
      className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-border bg-bg-elevated text-text-muted hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      <Icon_ className="h-4 w-4" aria-hidden />
    </button>
  );
}

function GameTab({
  envelope,
  index,
  isActive,
  onSelect,
  btnRef,
}: {
  envelope: PerGameScoutingEnvelope;
  index: number;
  isActive: boolean;
  onSelect: () => void;
  btnRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const isWin = envelope.result === "win";
  const isLoss = envelope.result === "loss";
  const dot = isWin
    ? "rgb(var(--success))"
    : isLoss
      ? "rgb(var(--danger))"
      : "rgb(var(--text-dim))";
  return (
    <button
      ref={btnRef}
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={onSelect}
      className={[
        "inline-flex flex-shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-caption font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        isActive
          ? "border border-accent/60 bg-accent/15 text-text shadow-sm"
          : "border border-border bg-bg-elevated text-text-muted hover:border-border-strong hover:text-text",
      ].join(" ")}
      data-testid="opponent-games-tab"
      data-active={isActive}
    >
      <span
        aria-hidden
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: dot }}
      />
      <span>#{index}</span>
      <span className="text-text-dim">{formatDuration(envelope.durationSec)}</span>
    </button>
  );
}

function GameDetailCard({ envelope }: { envelope: PerGameScoutingEnvelope }) {
  const isWin = envelope.result === "win";
  const isLoss = envelope.result === "loss";
  const chipBg = isWin
    ? "rgb(var(--success))"
    : isLoss
      ? "rgb(var(--danger))"
      : "rgb(var(--text-dim))";
  const chipFg = isWin ? "#06241B" : isLoss ? "#2A0708" : "#0a0d14";
  const dateLabel = formatDateLabel(envelope.date);
  const oppBuildUnavailable = envelope.flags.includes("opp_buildlog_missing");
  const myBuildUnavailable = envelope.flags.includes("my_buildlog_missing");
  const compositionUnavailable = envelope.flags.includes(
    "unit_timeline_missing",
  );
  const hasMySide = !!envelope.myCompositionByPhase || !!envelope.myBuildOrder;
  return (
    <div
      className="rounded-lg border border-border bg-bg-elevated p-4"
      data-testid="opponent-game-detail"
      data-game-id={envelope.gameId}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <span
          aria-label={envelope.result}
          className="inline-flex h-6 min-w-[24px] items-center justify-center rounded px-1.5 text-caption font-bold"
          style={{ backgroundColor: chipBg, color: chipFg }}
        >
          {isWin ? "W" : isLoss ? "L" : "T"}
        </span>
        <span className="font-mono text-sm font-semibold tabular-nums">
          {formatDuration(envelope.durationSec)}
        </span>
        {envelope.map ? (
          <span className="text-sm text-text-muted">{envelope.map}</span>
        ) : null}
        {dateLabel ? (
          <span className="text-caption text-text-dim">{dateLabel}</span>
        ) : null}
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <Pill kind="phase">
            ends · {PHASE_LABEL[envelope.endPhase]}
          </Pill>
          <Pill kind="reason">{END_REASON_LABEL[envelope.endReason]}</Pill>
        </span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <BuildLabel
          side="YOU"
          accent="rgb(var(--accent-cyan))"
          race={envelope.myRace}
          label={envelope.myBuild || "(unclassified)"}
        />
        <BuildLabel
          side="OPP"
          accent="rgb(var(--warning))"
          race={envelope.oppRace}
          label={envelope.oppStrategy || "(unclassified)"}
          name={envelope.oppName}
        />
      </div>

      <SideSection
        title="OPPONENT BUILD ORDER"
        accent="rgb(var(--warning))"
        events={envelope.oppBuildOrder}
        composition={envelope.oppCompositionByPhase}
        transitions={envelope.oppTransitions}
        buildOrderUnavailable={oppBuildUnavailable}
        compositionUnavailable={compositionUnavailable}
        emptyMessage="Opponent build log not extracted for this game."
      />

      {hasMySide ? (
        <SideSection
          title="YOUR BUILD ORDER"
          accent="rgb(var(--accent-cyan))"
          events={envelope.myBuildOrder ?? []}
          composition={envelope.myCompositionByPhase}
          transitions={envelope.myTransitions}
          buildOrderUnavailable={myBuildUnavailable}
          compositionUnavailable={compositionUnavailable}
          emptyMessage="Your build log not available for this game."
        />
      ) : null}

      <PhaseTransitionsRow
        oppTransitions={envelope.oppTransitions}
        myTransitions={envelope.myTransitions}
        durationSec={envelope.durationSec}
      />
    </div>
  );
}

function Pill({
  children,
  kind,
}: {
  children: React.ReactNode;
  kind: "phase" | "reason";
}) {
  const cls =
    kind === "phase"
      ? "border border-accent-cyan/40 bg-accent-cyan/10 text-accent-cyan"
      : "border border-warning/40 bg-warning/10 text-warning";
  return (
    <span
      className={[
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider tabular-nums",
        cls,
      ].join(" ")}
    >
      {children}
    </span>
  );
}

function BuildLabel({
  side,
  accent,
  race,
  label,
  name,
}: {
  side: string;
  accent: string;
  race?: string;
  label: string;
  name?: string;
}) {
  return (
    <div className="flex items-baseline gap-2 rounded-md border border-border bg-bg-surface px-3 py-2">
      <span
        className="text-[10px] font-extrabold uppercase tracking-wider"
        style={{ color: accent }}
      >
        {side}
      </span>
      {race ? (
        <Icon name={race} kind="race" size={14} alt={race} />
      ) : null}
      <span className="min-w-0 flex-1 truncate text-sm" title={name || label}>
        {label}
      </span>
      {name ? (
        <span className="ml-auto truncate text-caption text-text-dim" title={name}>
          {name}
        </span>
      ) : null}
    </div>
  );
}

function SideSection({
  title,
  accent,
  events,
  composition,
  transitions,
  buildOrderUnavailable,
  compositionUnavailable,
  emptyMessage,
}: {
  title: string;
  accent: string;
  events: PerGameScoutingEnvelope["oppBuildOrder"];
  composition?: PerGameScoutingEnvelope["oppCompositionByPhase"];
  transitions?: PerGameScoutingEnvelope["oppTransitions"];
  buildOrderUnavailable: boolean;
  compositionUnavailable: boolean;
  emptyMessage: string;
}) {
  return (
    <div className="mt-4 space-y-2">
      <div
        className="text-[10px] font-extrabold uppercase tracking-wider"
        style={{ color: accent }}
      >
        {title}
      </div>
      {buildOrderUnavailable ? (
        <div className="text-caption text-text-dim">{emptyMessage}</div>
      ) : (
        <BuildOrderStrip events={events} />
      )}
      {composition ? (
        compositionUnavailable ? (
          <div className="text-caption text-text-dim">
            Composition timeline unavailable for this game.
          </div>
        ) : (
          <CompositionGrid composition={composition} transitions={transitions} />
        )
      ) : null}
    </div>
  );
}

function BuildOrderStrip({
  events,
}: {
  events: PerGameScoutingEnvelope["oppBuildOrder"];
}) {
  const trimmed = events.slice(0, MAX_BUILD_ORDER_EVENTS);
  if (trimmed.length === 0) {
    return (
      <div className="text-caption text-text-dim">
        No build-order events recorded.
      </div>
    );
  }
  type GroupedEvents = typeof trimmed;
  const groups: Array<{ time: number; events: GroupedEvents }> = [];
  for (const ev of trimmed) {
    const last = groups[groups.length - 1];
    if (last && ev.time - last.time <= BUILD_ORDER_GROUP_GAP_SEC) {
      last.events.push(ev);
    } else {
      groups.push({ time: ev.time, events: [ev] });
    }
  }
  const hidden = events.length - trimmed.length;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {groups.map((g) => (
        <div
          key={`${g.time}-${g.events[0].name}`}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-surface px-1.5 py-1"
        >
          {g.events.map((ev) => (
            <Icon
              key={`${ev.name}-${ev.time}`}
              name={ev.name}
              kind={ev.category}
              size={20}
              alt={ev.name}
            />
          ))}
          <span className="ml-1 font-mono text-[10px] tabular-nums text-text-dim">
            {formatDuration(g.time)}
          </span>
        </div>
      ))}
      {hidden > 0 ? (
        <span className="text-caption text-text-dim">+{hidden} more</span>
      ) : null}
    </div>
  );
}

function CompositionGrid({
  composition,
  transitions,
}: {
  composition: PerGameScoutingEnvelope["oppCompositionByPhase"];
  transitions?: PerGameScoutingEnvelope["oppTransitions"];
}) {
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-5">
      {PHASE_ORDER.map((phase) => {
        const slice = composition[phase];
        const reached = !!slice && slice.reached;
        const crossing = transitions ? phaseStart(transitions, phase) : null;
        return (
          <div
            key={phase}
            className="rounded-md border border-border bg-bg-surface p-2"
            data-testid="opponent-game-phase-card"
            data-phase={phase}
            data-reached={reached}
          >
            <div className="flex items-baseline justify-between gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-text-dim">
                {PHASE_SHORT[phase]}
              </span>
              {crossing != null ? (
                <span className="font-mono text-[10px] tabular-nums text-text-dim">
                  {formatDuration(crossing)}
                </span>
              ) : null}
            </div>
            {!reached ? (
              <div className="mt-1 text-caption text-text-dim">Did not reach</div>
            ) : slice.units.length === 0 ? (
              <div className="mt-1 text-caption text-text-dim">—</div>
            ) : (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {slice.units.map((u) => (
                  <span
                    key={u.token}
                    className="inline-flex items-center gap-0.5 tabular-nums"
                  >
                    <Icon name={u.token} kind="unit" size={18} alt={u.token} />
                    <span className="text-caption">{u.count}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function phaseStart(
  transitions: PerGameScoutingEnvelope["oppTransitions"],
  phase: Phase,
): number | null {
  switch (phase) {
    case "early":
      return 0;
    case "earlyMid":
      return transitions.earlyMidAt;
    case "mid":
      return transitions.midAt;
    case "midLate":
      return transitions.midLateAt;
    case "late":
      return transitions.lateAt;
  }
}

function PhaseTransitionsRow({
  oppTransitions,
  myTransitions,
  durationSec,
}: {
  oppTransitions: PerGameScoutingEnvelope["oppTransitions"];
  myTransitions?: PerGameScoutingEnvelope["myTransitions"];
  durationSec: number;
}) {
  const rows: Array<{
    key: string;
    label: string;
    accent: string;
    times: PerGameScoutingEnvelope["oppTransitions"] | undefined;
  }> = [
    {
      key: "opp",
      label: "OPP",
      accent: "rgb(var(--warning))",
      times: oppTransitions,
    },
  ];
  if (myTransitions) {
    rows.push({
      key: "my",
      label: "YOU",
      accent: "rgb(var(--accent-cyan))",
      times: myTransitions,
    });
  }
  return (
    <div className="mt-4 space-y-1.5">
      <div className="text-[10px] font-extrabold uppercase tracking-wider text-text-dim">
        Phase transitions
      </div>
      {rows.map((row) => (
        <div
          key={row.key}
          className="flex flex-wrap items-center gap-2 text-caption"
        >
          <span
            className="inline-flex w-9 justify-center rounded border px-1 py-0.5 text-[10px] font-bold uppercase tracking-wider tabular-nums"
            style={{ color: row.accent, borderColor: `${row.accent}55` }}
          >
            {row.label}
          </span>
          {(["earlyMid", "mid", "midLate", "late"] as Phase[]).map((p) => {
            const t = row.times ? phaseStart(row.times, p) : null;
            return (
              <span
                key={p}
                className="inline-flex items-center gap-1 rounded bg-bg-surface px-1.5 py-0.5 font-mono tabular-nums"
              >
                <span className="text-text-dim">{PHASE_SHORT[p]}</span>
                <span className={t == null ? "text-text-dim" : "text-text"}>
                  {t == null ? "—" : formatDuration(t)}
                </span>
              </span>
            );
          })}
          <span className="ml-auto font-mono text-text-dim tabular-nums">
            end · {formatDuration(durationSec)}
          </span>
        </div>
      ))}
    </div>
  );
}

function FinalPhaseDistribution({
  finalPhaseDistribution,
  sampleSize,
  totalGames,
}: {
  finalPhaseDistribution?: Partial<Record<Phase, number>>;
  sampleSize?: Partial<Record<Phase, number>>;
  totalGames: number;
}) {
  const dist = finalPhaseDistribution || {};
  const total = PHASE_ORDER.reduce((acc, p) => acc + (dist[p] || 0), 0);
  const fallback = total === 0;
  if (fallback) {
    return (
      <div className="text-caption text-text-dim">
        {totalGames} games shown — newest first
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-caption">
        <span className="font-bold uppercase tracking-wider text-text-dim">
          Where games end
        </span>
        <span className="text-text-dim">{total} games</span>
      </div>
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full border border-border bg-bg-surface"
        aria-label="Phase the game ended in, across all matches"
      >
        {PHASE_ORDER.map((p) => {
          const v = dist[p] || 0;
          const pct = total > 0 ? (v / total) * 100 : 0;
          if (pct <= 0) return null;
          return (
            <div
              key={p}
              title={`${PHASE_LABEL[p]} · ${v} · ${Math.round(pct)}%`}
              style={{
                width: `${pct}%`,
                backgroundColor: PHASE_DIST_COLOR[p],
              }}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-caption text-text-dim">
        {PHASE_ORDER.map((p) => {
          const v = dist[p] || 0;
          if (v <= 0) return null;
          const sample = sampleSize?.[p];
          return (
            <span
              key={p}
              className="inline-flex items-center gap-1.5 tabular-nums"
            >
              <span
                aria-hidden
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: PHASE_DIST_COLOR[p] }}
              />
              <span>{PHASE_LABEL[p]}</span>
              <span className="text-text">{v}</span>
              {typeof sample === "number" && sample > v ? (
                <span>· reached by {sample}</span>
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function formatDuration(sec: number): string {
  const n = Math.max(0, Math.round(sec));
  const m = Math.floor(n / 60);
  const s = n - m * 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDateLabel(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
