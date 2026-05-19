"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ChevronRight } from "lucide-react";
import { EmptyState } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { fmtMinutes, wrColor } from "@/lib/format";

export type Phase = "early" | "earlyMid" | "mid" | "midLate" | "late";

export type PhaseSignature = {
  key: string;
  /**
   * Headline composition shown by default — the top 3 tokens that
   * defined this cluster. Each ``count`` is the MEDIAN across the
   * games in the bucket (not a single sample).
   */
  units: Array<{ token: string; count: number; sampleCount?: number }>;
  /**
   * Every non-worker unit observed in games matching this bucket
   * (capped server-side). Powers the "show all units" expansion.
   */
  fullComposition?: Array<{
    token: string;
    count: number;
    sampleCount?: number;
  }>;
  sampleCount: number;
  wins: number;
  losses: number;
  winRate: number;
  sampleGameIds: string[];
};

export type PhaseTechRow = {
  token: string;
  sampleCount: number;
  medianFirstSeen: number;
  p25: number;
  p75: number;
};

export type PhaseCompositionRow = {
  signatures: PhaseSignature[];
  tech: PhaseTechRow[];
  upgrades: PhaseTechRow[];
};

/**
 * One strategy bucket — same shape the server emits in
 * ``BuildPhasePayload.byStrategy``. Lifted here (instead of importing
 * from ``serverApi``) so the component can be drop-tested in isolation
 * without dragging the Next-side data layer into the test bundle.
 */
export type PhaseStrategyEnvelope = {
  strategy: string;
  race: string | null;
  games: number;
  wins: number;
  losses: number;
  winRate: number;
  phases: {
    sampleSize: Record<Phase, number>;
    perPhase: Record<Phase, PhaseCompositionRow>;
    finalPhaseDistribution: Record<Phase, number>;
    medianCrossings: {
      earlyMidAt: number | null;
      midAt: number | null;
      midLateAt: number | null;
      lateAt: number | null;
    };
    durationP95Sec: number;
    flags?: string[];
  };
};

export type PhaseCompositionTabsProps = {
  sampleSize: Record<Phase, number>;
  perPhase: Record<Phase, PhaseCompositionRow>;
  onSignatureClick?: (sampleGameIds: string[]) => void;
  showTechRow?: boolean;
  /**
   * Optional initial tab. When the requested phase has zero samples
   * the component falls back to the first reached phase.
   */
  preferredPhase?: Phase;
  /**
   * Optional per-strategy breakdowns — when present, the panel for
   * the active phase renders a "Strategies that play out here"
   * section underneath the aggregate composition cards. Each row
   * shows the strategy's typical Opening / Mid / Late composition
   * with real unit + tech timings (no mock data — entries come from
   * the server's ``computeByStrategyPhases`` helper).
   */
  byStrategy?: PhaseStrategyEnvelope[];
  /**
   * Click handler for "Open N games" CTA on a strategy card. The
   * caller decides whether to open a filtered games table, a
   * pre-selected build dossier, etc.
   */
  onStrategyOpen?: (strategy: string) => void;
};

const PHASE_ORDER: Phase[] = ["early", "earlyMid", "mid", "midLate", "late"];

const PHASE_LABELS: Record<Phase, string> = {
  early: "Early",
  earlyMid: "Early/Mid",
  mid: "Mid",
  midLate: "Mid/Late",
  late: "Late",
};

const PHASE_SHORT_LABELS: Record<Phase, string> = {
  early: "Early",
  earlyMid: "E/Mid",
  mid: "Mid",
  midLate: "M/Late",
  late: "Late",
};

const PHASE_ACCENT: Record<Phase, string> = {
  early: "rgb(var(--text-muted))",
  earlyMid: "rgb(var(--accent))",
  mid: "rgb(var(--accent-cyan))",
  midLate: "rgb(var(--warning))",
  late: "rgb(var(--danger))",
};

export function PhaseCompositionTabs({
  sampleSize,
  perPhase,
  onSignatureClick,
  showTechRow = true,
  preferredPhase,
  byStrategy,
  onStrategyOpen,
}: PhaseCompositionTabsProps) {
  const initial = useMemo<Phase>(() => {
    if (preferredPhase && (sampleSize[preferredPhase] ?? 0) > 0) {
      return preferredPhase;
    }
    for (const p of PHASE_ORDER) if ((sampleSize[p] ?? 0) > 0) return p;
    return "early";
  }, [sampleSize, preferredPhase]);
  const [active, setActive] = useState<Phase>(initial);
  const tabRefs = useRef<Partial<Record<Phase, HTMLButtonElement | null>>>({});

  useEffect(() => {
    const node = tabRefs.current[active];
    if (!node || typeof node.scrollIntoView !== "function") return;
    node.scrollIntoView({
      behavior: "smooth",
      inline: "center",
      block: "nearest",
    });
  }, [active]);

  const activeRow = perPhase[active];
  const activeSamples = sampleSize[active] ?? 0;
  const signatures = useMemo(
    () =>
      activeRow
        ? [...activeRow.signatures].sort(
            (a, b) => b.sampleCount - a.sampleCount,
          )
        : [],
    [activeRow],
  );

  const totalWins = signatures.reduce((s, sig) => s + sig.wins, 0);
  const totalLosses = signatures.reduce((s, sig) => s + sig.losses, 0);
  const totalGames = totalWins + totalLosses;
  const overallWr = totalGames > 0 ? totalWins / totalGames : 0;

  return (
    <div className="space-y-4" data-testid="phase-composition-tabs">
      {/* Underlined tab row — real tab affordance, not stat-card buttons. */}
      <div
        role="tablist"
        aria-label="Phase compositions"
        aria-orientation="horizontal"
        className="-mx-1 flex snap-x snap-mandatory items-stretch gap-1 overflow-x-auto border-b border-border px-1 scrollbar-thin md:overflow-visible"
      >
        {PHASE_ORDER.map((phase) => {
          const count = sampleSize[phase] ?? 0;
          const disabled = count === 0;
          const selected = active === phase;
          return (
            <button
              key={phase}
              ref={(el) => {
                tabRefs.current[phase] = el;
              }}
              type="button"
              role="tab"
              data-phase={phase}
              data-testid="phase-tab"
              aria-selected={selected}
              aria-disabled={disabled || undefined}
              disabled={disabled}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                if (disabled) return;
                setActive(phase);
              }}
              style={
                selected
                  ? { borderBottomColor: PHASE_ACCENT[phase] }
                  : undefined
              }
              className={[
                "inline-flex min-h-[40px] shrink-0 snap-start items-center gap-2 -mb-px border-b-2 border-transparent px-3 py-2 text-caption transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                selected
                  ? "text-text font-semibold"
                  : disabled
                    ? "cursor-not-allowed text-text-dim"
                    : "text-text-muted hover:text-text",
              ].join(" ")}
            >
              <span data-testid="phase-tab-label">
                <span className="md:hidden" data-testid="phase-tab-label-short">
                  {PHASE_SHORT_LABELS[phase]}
                </span>
                <span
                  className="hidden md:inline"
                  data-testid="phase-tab-label-long"
                >
                  {PHASE_LABELS[phase]}
                </span>
              </span>
              <span
                data-testid="phase-tab-count"
                className={[
                  "min-w-[1.5rem] rounded-full border px-1.5 text-center text-[10px] font-semibold tabular-nums",
                  selected
                    ? "border-transparent bg-bg-elevated text-text"
                    : disabled
                      ? "border-border bg-transparent text-text-dim"
                      : "border-border bg-bg-elevated text-text-muted",
                ].join(" ")}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        aria-label={`${PHASE_LABELS[active]} compositions`}
        data-testid="phase-tab-panel"
        data-active-phase={active}
        className="space-y-4"
      >
        <ActivePhaseHeader
          phase={active}
          samples={activeSamples}
          wins={totalWins}
          losses={totalLosses}
          wr={overallWr}
          sparse={activeSamples === 0 || signatures.length === 0}
        />
        {renderActiveBody({
          activeRow,
          activeSamples,
          signatures,
          onSignatureClick,
          showTechRow,
          phase: active,
        })}
        {byStrategy && byStrategy.length > 0 ? (
          <StrategyBreakdown
            phase={active}
            strategies={byStrategy}
            onStrategyOpen={onStrategyOpen}
          />
        ) : null}
      </div>
    </div>
  );
}

function ActivePhaseHeader({
  phase,
  samples,
  wins,
  losses,
  wr,
  sparse,
}: {
  phase: Phase;
  samples: number;
  wins: number;
  losses: number;
  wr: number;
  sparse: boolean;
}) {
  const denom = wins + losses;
  const showWr = denom > 0;
  const wrText = showWr ? `${Math.round(wr * 100)}%` : "—";
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 text-[11px] uppercase tracking-wider text-text-dim">
      <div className="flex items-baseline gap-2">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: PHASE_ACCENT[phase] }}
          aria-hidden="true"
        />
        <span className="font-semibold text-text-muted">
          {PHASE_LABELS[phase]} game state
        </span>
        {!sparse ? (
          <span className="normal-case tracking-normal text-text-dim">
            {samples} game{samples === 1 ? "" : "s"} reached this phase
          </span>
        ) : null}
      </div>
      {showWr ? (
        <span
          className="rounded-md border border-border bg-bg-elevated px-2 py-0.5 font-mono text-[11px] normal-case tracking-normal tabular-nums"
          style={{ color: wrColor(wr, denom) }}
          title={`${wins} wins · ${losses} losses across ${denom} completed games`}
        >
          {wins}–{losses} · {wrText}
        </span>
      ) : null}
    </div>
  );
}

function renderActiveBody({
  activeRow,
  activeSamples,
  signatures,
  onSignatureClick,
  showTechRow,
  phase,
}: {
  activeRow: PhaseCompositionRow | undefined;
  activeSamples: number;
  signatures: PhaseSignature[];
  onSignatureClick: PhaseCompositionTabsProps["onSignatureClick"];
  showTechRow: boolean;
  phase: Phase;
}) {
  if (!activeRow || activeSamples === 0) {
    return (
      <EmptyState
        title="No games reached this phase yet"
        sub="Play a few longer games on this build to see what you're typically fielding here."
      />
    );
  }
  if (signatures.length === 0) {
    if (typeof console !== "undefined") {
      console.warn(
        `[PhaseCompositionTabs] ${activeSamples} game(s) reached ${phase} ` +
          `but no signatures were computed — data-shape regression?`,
      );
    }
    return (
      <EmptyState
        title="Composition data still landing"
        sub={
          `${activeSamples} game${activeSamples === 1 ? "" : "s"} on this build ` +
          `reached this phase but signatures haven't been computed yet.`
        }
      />
    );
  }
  return (
    <div className="space-y-4">
      <ul
        className="grid gap-3"
        style={{
          // Auto-fit so composition cards keep enough room for the
          // unit row + WR pill + sample-size footer regardless of the
          // parent container's width. ~240px per card matches the
          // designed minimum for the dense head row (3 UnitBadges
          // ~44px each + WR pill + gap).
          gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
        }}
        data-testid="composition-cards"
      >
        {signatures.map((sig) => (
          <CompositionCard
            key={sig.key}
            signature={sig}
            onClick={onSignatureClick}
          />
        ))}
      </ul>
      {showTechRow ? (
        <div className="hidden md:block">
          <TechTimeline tech={activeRow.tech} upgrades={activeRow.upgrades} />
        </div>
      ) : null}
    </div>
  );
}

function CompositionCard({
  signature,
  onClick,
}: {
  signature: PhaseSignature;
  onClick: PhaseCompositionTabsProps["onSignatureClick"];
}) {
  const [expanded, setExpanded] = useState(false);
  const total = signature.wins + signature.losses;
  const wrText = total > 0 ? `${signature.wins}–${signature.losses}` : "—";
  const wr = signature.winRate;
  const wrPct = total > 0 ? Math.round(wr * 100) : 0;
  const interactive = !!onClick && signature.sampleGameIds.length > 0;

  const head = signature.units;
  const all = signature.fullComposition ?? signature.units;
  const headTokens = new Set(head.map((u) => u.token));
  const extras = all.filter((u) => !headTokens.has(u.token));
  const hasMore = extras.length > 0;

  const activate = () => {
    if (!interactive) return;
    onClick?.(signature.sampleGameIds);
  };

  const handleKey = (e: KeyboardEvent<HTMLLIElement>) => {
    if (!interactive) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    }
  };

  return (
    <li
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : -1}
      onClick={interactive ? activate : undefined}
      onKeyDown={interactive ? handleKey : undefined}
      aria-label={
        interactive
          ? `Open ${head.map((u) => `${u.count} ${u.token}`).join(", ") || "this composition"}`
          : undefined
      }
      data-testid="composition-card"
      data-signature-key={signature.key}
      className={[
        "flex min-h-[44px] flex-col gap-3 rounded-lg border border-border bg-bg-surface p-3",
        interactive
          ? "cursor-pointer transition-colors hover:bg-bg-elevated hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg motion-safe:hover:-translate-y-px"
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {head.length === 0 ? (
            <span className="text-caption font-medium text-text-muted">
              {signature.key === "Other"
                ? "Mixed / rare compositions"
                : signature.key || "Other"}
            </span>
          ) : (
            head.map((u) => (
              <UnitBadge key={u.token} token={u.token} count={u.count} />
            ))
          )}
        </div>
        <span
          className="whitespace-nowrap rounded-md border border-border bg-bg-elevated px-2 py-0.5 font-mono text-caption tabular-nums"
          style={{ color: wrColor(wr, total) }}
          data-testid="wr-pill"
          title={
            total > 0
              ? `${signature.wins} wins, ${signature.losses} losses`
              : "No completed games yet"
          }
        >
          {wrText}
        </span>
      </div>

      {total > 0 ? (
        <div className="space-y-1">
          <div
            className="relative h-1.5 w-full overflow-hidden rounded-full bg-bg-elevated"
            aria-hidden="true"
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${wrPct}%`,
                background: wrColor(wr, total),
                opacity: 0.85,
              }}
            />
            <span
              className="absolute top-0 h-full w-px bg-border"
              style={{ left: "50%" }}
            />
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 text-[11px] text-text-dim">
        <span>
          {head.length > 0
            ? `Median across ${signature.sampleCount} game${signature.sampleCount === 1 ? "" : "s"}`
            : `${signature.sampleCount} game${signature.sampleCount === 1 ? "" : "s"} across rare comps`}
        </span>
        {hasMore ? (
          <button
            type="button"
            data-testid="composition-toggle-extras"
            aria-expanded={expanded}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            className="rounded-md border border-border bg-bg px-2 py-0.5 text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface"
          >
            {expanded
              ? "Hide details"
              : `+${extras.length} more unit${extras.length === 1 ? "" : "s"}`}
          </button>
        ) : null}
      </div>

      {interactive ? (
        <div className="-mb-1 -mr-1 flex items-center justify-end text-[11px] text-text-muted">
          <span className="inline-flex items-center gap-1">
            Open games
            <ChevronRight className="h-3 w-3" aria-hidden />
          </span>
        </div>
      ) : null}

      {expanded && hasMore ? (
        <ExtrasGrid units={extras} totalGames={signature.sampleCount} />
      ) : null}
    </li>
  );
}

function ExtrasGrid({
  units,
  totalGames,
}: {
  units: Array<{ token: string; count: number; sampleCount?: number }>;
  totalGames: number;
}) {
  return (
    <ul
      className="grid gap-2 border-t border-border pt-2"
      style={{
        // Auto-fit to the available width so unit cards never get
        // crammed when the parent column is narrow (e.g. the half-
        // width column inside ``BuildVsStrategyComparison`` at xl).
        // Each card needs ~150px to fit the icon + token name +
        // "~N · NN%" line without truncation overlap.
        gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
      }}
      data-testid="composition-extras"
    >
      {units.map((u) => {
        const seen = u.sampleCount ?? 0;
        const coverage =
          totalGames > 0 ? Math.round((100 * seen) / totalGames) : 0;
        return (
          <li
            key={u.token}
            className="flex items-center gap-2 rounded-md border border-border bg-bg px-2 py-1.5"
          >
            <Icon name={u.token} kind="unit" size={24} alt={u.token} />
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-[11px] text-text" title={u.token}>
                {u.token}
              </span>
              <span className="text-[10px] tabular-nums text-text-dim">
                ~{u.count}
                {seen > 0
                  ? totalGames > 0
                    ? ` · ${coverage}%`
                    : ` · ${seen}g`
                  : ""}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function UnitBadge({ token, count }: { token: string; count: number }) {
  return (
    <span
      className="relative inline-flex h-10 w-10 items-center justify-center rounded-md border border-border bg-bg-elevated md:h-11 md:w-11"
      data-testid="unit-badge"
      data-token={token}
      title={`${token} · ~${count} per game (median)`}
    >
      <Icon
        name={token}
        kind="unit"
        size={32}
        className="md:hidden"
        alt={token}
      />
      <Icon
        name={token}
        kind="unit"
        size={36}
        className="hidden md:block"
        alt={token}
      />
      <span
        className="absolute -bottom-1 -right-1 inline-flex min-w-[18px] items-center justify-center rounded-full border border-border bg-bg px-1 text-[10px] font-semibold tabular-nums text-text"
        aria-hidden="true"
      >
        {count}
      </span>
    </span>
  );
}

/**
 * Race -> letter normalization. The server emits whichever form the
 * extractor produced ("Z", "Zerg", "zerg") and we want one canonical
 * token for the race rail / badge so styling lookups don't fork.
 */
function normalizeRace(raw: string | null | undefined): "Z" | "P" | "T" | "R" | null {
  if (!raw) return null;
  const head = raw.trim().toUpperCase().charAt(0);
  if (head === "Z" || head === "P" || head === "T" || head === "R") return head;
  return null;
}

const RACE_RAIL_COLORS: Record<"Z" | "P" | "T" | "R", string> = {
  Z: "rgb(179, 136, 255)",
  P: "rgb(255, 213, 79)",
  T: "rgb(77, 208, 225)",
  R: "rgb(var(--text-muted))",
};

const RACE_BADGE_BG: Record<"Z" | "P" | "T" | "R", string> = {
  Z: "rgba(179, 136, 255, 0.18)",
  P: "rgba(255, 213, 79, 0.18)",
  T: "rgba(77, 208, 225, 0.18)",
  R: "rgb(var(--bg-elevated))",
};

const REVERSE_PHASE_ORDER: Phase[] = [
  "late",
  "midLate",
  "mid",
  "earlyMid",
  "early",
];

/**
 * Pick the most-relevant "snapshot" phase for each column of a
 * strategy card. Falls through to lower-order phases when the
 * canonical pick has zero samples, so a strategy that always ends
 * in Early/Mid still shows its Mid/Late columns dimmed rather than
 * blank.
 */
function pickSnapshotPhase(
  candidates: Phase[],
  sampleSize: Record<Phase, number>,
): Phase | null {
  for (const p of candidates) {
    if ((sampleSize[p] ?? 0) > 0) return p;
  }
  return null;
}

/**
 * "Strategies that play out here" — per-strategy storyline cards
 * filtered by the active phase. A strategy appears if it reached the
 * active phase in at least one game. Each card carries an Opening /
 * Mid / Late mini-column trio sourced from the same
 * ``computeCompositions`` pipeline as the aggregate cards above, just
 * filtered down to that strategy's game subset.
 */
function StrategyBreakdown({
  phase,
  strategies,
  onStrategyOpen,
}: {
  phase: Phase;
  strategies: PhaseStrategyEnvelope[];
  onStrategyOpen?: (strategy: string) => void;
}) {
  // Surface strategies whose games actually reached the active phase.
  const relevant = useMemo(() => {
    return strategies
      .filter((s) => (s.phases.sampleSize[phase] ?? 0) > 0)
      .sort((a, b) => b.games - a.games);
  }, [strategies, phase]);

  if (relevant.length === 0) {
    return null;
  }

  return (
    <section
      data-testid="strategy-breakdown"
      data-active-phase={phase}
      aria-label={`Strategies seen at the ${PHASE_LABELS[phase]} phase`}
      className="space-y-3 border-t border-border pt-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Strategies that play out at {PHASE_LABELS[phase]}
        </h3>
        <span className="text-[11px] text-text-dim">
          {relevant.length} strateg{relevant.length === 1 ? "y" : "ies"}
        </span>
      </div>
      <ul
        className="space-y-2"
        data-testid="strategy-breakdown-list"
      >
        {relevant.map((s) => (
          <StrategyCard
            key={s.strategy}
            envelope={s}
            phase={phase}
            onOpen={onStrategyOpen}
          />
        ))}
      </ul>
    </section>
  );
}

function StrategyCard({
  envelope,
  phase,
  onOpen,
}: {
  envelope: PhaseStrategyEnvelope;
  phase: Phase;
  onOpen?: (strategy: string) => void;
}) {
  const race = normalizeRace(envelope.race);
  const denom = envelope.wins + envelope.losses;
  const wr = envelope.winRate;
  const wrPct = denom > 0 ? Math.round(wr * 100) : 0;
  const wrLabel = denom > 0 ? `${wrPct}%` : "—";

  // Build the Opening / Mid / Late chronological columns. Each column
  // names a fixed phase window and falls back to a neighboring window
  // when its canonical phase had no samples for this strategy.
  const phases = envelope.phases.perPhase;
  const ss = envelope.phases.sampleSize;
  const openingPhase = pickSnapshotPhase(["earlyMid", "early"], ss);
  const midPhase = pickSnapshotPhase(["mid", "earlyMid"], ss);
  const latePhase = pickSnapshotPhase(["late", "midLate", "mid"], ss);

  const interactive = !!onOpen;

  const finalPhase = (() => {
    let best: Phase = "early";
    let bestCount = -1;
    for (const p of REVERSE_PHASE_ORDER) {
      const c = envelope.phases.finalPhaseDistribution[p] ?? 0;
      if (c > bestCount) {
        best = p;
        bestCount = c;
      }
    }
    return best;
  })();

  return (
    <li
      data-testid="strategy-card"
      data-strategy={envelope.strategy}
      data-race={race ?? ""}
      data-active-phase={phase}
      className="relative overflow-hidden rounded-lg border border-border bg-bg-elevated"
    >
      <span
        aria-hidden="true"
        className="absolute left-0 top-0 h-full w-1"
        style={{ background: race ? RACE_RAIL_COLORS[race] : "rgb(var(--text-muted))" }}
      />
      <div className="space-y-2 pl-3 pr-3 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-[12px] font-bold leading-none"
              style={{
                background: race ? RACE_BADGE_BG[race] : "rgb(var(--bg-surface))",
                color: race ? RACE_RAIL_COLORS[race] : "rgb(var(--text-muted))",
              }}
              aria-hidden="true"
            >
              {race ? (
                <Icon
                  name={race}
                  kind="race"
                  size={20}
                  fallback={race}
                  alt={race}
                  decorative
                />
              ) : (
                "?"
              )}
            </span>
            <div className="min-w-0">
              <div
                className="truncate text-[13px] font-semibold leading-tight text-text"
                title={envelope.strategy}
              >
                {envelope.strategy}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-text-dim">
                {envelope.games} game{envelope.games === 1 ? "" : "s"}
                {" · "}
                usually ends {PHASE_LABELS[finalPhase]}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="rounded-md border border-border bg-bg-surface px-2 py-0.5 font-mono text-[11px] tabular-nums"
              style={{ color: wrColor(wr, denom) }}
              data-testid="strategy-wr-pill"
              title={
                denom > 0
                  ? `${envelope.wins} wins, ${envelope.losses} losses`
                  : "No completed games yet"
              }
            >
              {envelope.wins}–{envelope.losses}
              <span className="ml-1 text-text-dim">·</span>
              <span className="ml-1">{wrLabel}</span>
            </span>
          </div>
        </div>

        {denom > 0 ? (
          <div
            className="relative h-1.5 w-full overflow-hidden rounded-full bg-bg-surface"
            aria-hidden="true"
            data-testid="strategy-wr-bar"
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${wrPct}%`,
                background: wrColor(wr, denom),
                opacity: 0.85,
              }}
            />
            <span
              className="absolute top-0 h-full w-px bg-border"
              style={{ left: "50%" }}
            />
          </div>
        ) : null}

        <div
          className="grid grid-cols-1 gap-2 sm:grid-cols-3"
          data-testid="strategy-columns"
        >
          <StrategyColumn
            label="Opening"
            timeRange="0:00 – early/mid"
            phase={openingPhase}
            sourceRow={openingPhase ? phases[openingPhase] : undefined}
            isActive={phase === openingPhase}
          />
          <StrategyColumn
            label="Mid"
            timeRange="mid game"
            phase={midPhase}
            sourceRow={midPhase ? phases[midPhase] : undefined}
            isActive={phase === midPhase}
          />
          <StrategyColumn
            label="Late"
            timeRange="late game"
            phase={latePhase}
            sourceRow={latePhase ? phases[latePhase] : undefined}
            isActive={phase === latePhase}
          />
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between border-t border-border bg-bg-surface/50 px-3 py-2">
        <span className="text-[11px] text-text-muted">
          Showing typical play across {envelope.games} game
          {envelope.games === 1 ? "" : "s"}
        </span>
        {interactive ? (
          <button
            type="button"
            data-testid="strategy-open-btn"
            data-strategy={envelope.strategy}
            onClick={() => onOpen?.(envelope.strategy)}
            className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1 text-[11px] font-semibold text-white hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-elevated"
          >
            Open {envelope.games} game{envelope.games === 1 ? "" : "s"}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : (
          <span className="text-[11px] text-text-dim">—</span>
        )}
      </div>
    </li>
  );
}

function StrategyColumn({
  label,
  timeRange,
  phase,
  sourceRow,
  isActive,
}: {
  label: string;
  timeRange: string;
  phase: Phase | null;
  sourceRow: PhaseCompositionRow | undefined;
  isActive?: boolean;
}) {
  // Pick the top signature (most common cluster) for this phase and
  // up to 2 tech timings — keeps the card scannable without
  // truncating to uselessness.
  const topSignature = sourceRow?.signatures
    ? [...sourceRow.signatures].sort(
        (a, b) => b.sampleCount - a.sampleCount,
      )[0]
    : undefined;
  const topUnits = (topSignature?.units ?? []).slice(0, 3);
  const tech = (sourceRow?.tech ?? []).slice(0, 2);
  const upgrades = (sourceRow?.upgrades ?? []).slice(0, 1);
  const hasContent = topUnits.length > 0 || tech.length > 0;

  return (
    <div
      className={[
        "rounded-md border border-border bg-bg-surface p-2",
        isActive ? "ring-1 ring-accent/40" : "",
        !hasContent ? "opacity-60" : "",
      ].join(" ")}
      data-testid="strategy-column"
      data-column={label.toLowerCase()}
      data-phase={phase ?? ""}
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-dim">
          {label}
        </span>
        <span className="font-mono text-[9px] uppercase tracking-wider text-text-dim">
          {phase ? PHASE_SHORT_LABELS[phase] : "—"}
        </span>
      </div>
      {!hasContent ? (
        <div className="text-[11px] text-text-dim">
          Usually ends before this point
        </div>
      ) : (
        <>
          <ul className="mb-1.5 flex flex-wrap gap-1">
            {topUnits.length === 0 ? (
              <li className="text-[11px] text-text-dim">—</li>
            ) : (
              topUnits.map((u) => (
                <li
                  key={u.token}
                  data-testid="strategy-column-unit"
                  data-token={u.token}
                  className="inline-flex items-center gap-1 rounded border border-border bg-bg-elevated px-1.5 py-0.5"
                >
                  <Icon name={u.token} kind="unit" size={16} alt={u.token} />
                  <span className="font-mono text-[10px] tabular-nums text-text">
                    {u.count}
                  </span>
                </li>
              ))
            )}
          </ul>
          {tech.length > 0 || upgrades.length > 0 ? (
            <ul
              className="space-y-0.5 text-[10px] text-text-muted"
              data-testid="strategy-column-tech"
            >
              {tech.map((t) => (
                <li
                  key={`b:${t.token}`}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="flex items-center gap-1 truncate">
                    <Icon
                      name={t.token}
                      kind="building"
                      size={12}
                      alt={t.token}
                    />
                    <span className="truncate">{t.token}</span>
                  </span>
                  <span className="font-mono tabular-nums text-text-dim">
                    {fmtMinutes(t.medianFirstSeen)}
                  </span>
                </li>
              ))}
              {upgrades.map((t) => (
                <li
                  key={`u:${t.token}`}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="flex items-center gap-1 truncate">
                    <Icon
                      name={t.token}
                      kind="upgrade"
                      size={12}
                      alt={t.token}
                    />
                    <span className="truncate">{t.token}</span>
                  </span>
                  <span className="font-mono tabular-nums text-text-dim">
                    {fmtMinutes(t.medianFirstSeen)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Tech timeline: a horizontal track with median first-seen markers and
 * p25-p75 confidence bands per tech/upgrade. Buildings render with
 * ``kind="building"`` and upgrades fall back to ``kind="upgrade"`` so
 * the icon component picks the right asset folder.
 */
function TechTimeline({
  tech,
  upgrades,
}: {
  tech: PhaseTechRow[];
  upgrades?: PhaseTechRow[];
}) {
  type Row = PhaseTechRow & { kind: "building" | "upgrade" };
  const rows = useMemo<Row[]>(() => {
    const merged: Row[] = [];
    for (const t of tech ?? []) merged.push({ ...t, kind: "building" });
    for (const u of upgrades ?? []) merged.push({ ...u, kind: "upgrade" });
    return merged;
  }, [tech, upgrades]);

  const { minBound, span } = useMemo(() => {
    if (rows.length === 0) return { minBound: 0, span: 1 };
    let lo = Infinity;
    let hi = -Infinity;
    for (const t of rows) {
      if (t.p25 < lo) lo = t.p25;
      if (t.p75 > hi) hi = t.p75;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      return { minBound: 0, span: 1 };
    }
    if (hi === lo) return { minBound: lo, span: 1 };
    return { minBound: lo, span: hi - lo };
  }, [rows]);

  if (rows.length === 0) return null;

  const toPct = (sec: number) =>
    Math.max(0, Math.min(100, ((sec - minBound) / span) * 100));

  return (
    <div className="space-y-1" data-testid="tech-timeline">
      <div className="flex items-baseline justify-between text-[10px] uppercase tracking-wider text-text-dim">
        <span className="font-semibold">Tech & upgrade timings</span>
        <span className="font-mono tabular-nums normal-case tracking-normal text-text-muted">
          {fmtMinutes(minBound)} – {fmtMinutes(minBound + span)}
        </span>
      </div>
      <div className="relative h-9 w-full rounded-md border border-border bg-bg-elevated">
        {rows.map((t) => {
          const left = toPct(t.medianFirstSeen);
          const bandLeft = toPct(t.p25);
          const bandWidth = Math.max(0, toPct(t.p75) - bandLeft);
          const tooltip =
            `${t.token}: ${t.sampleCount} game${t.sampleCount === 1 ? "" : "s"}, ` +
            `median ${fmtMinutes(t.medianFirstSeen)} ` +
            `(p25-p75 ${fmtMinutes(t.p25)} – ${fmtMinutes(t.p75)})`;
          return (
            <div
              key={`${t.kind}:${t.token}`}
              className="absolute inset-y-0"
              style={{ left: 0, right: 0 }}
              data-testid="tech-marker"
              data-token={t.token}
              data-kind={t.kind}
              data-median-pct={left}
              data-p25-pct={bandLeft}
              data-p75-pct={bandLeft + bandWidth}
              title={tooltip}
            >
              <span
                className="absolute top-1/2 h-3 -translate-y-1/2 rounded-full bg-text-dim/25"
                style={{ left: `${bandLeft}%`, width: `${bandWidth}%` }}
                aria-hidden="true"
                data-testid="tech-band"
              />
              <span
                className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${left}%` }}
              >
                <Icon
                  name={t.token}
                  kind={t.kind}
                  size={22}
                  alt={t.token}
                />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
