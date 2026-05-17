"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { EmptyState } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { fmtMinutes, wrColor } from "@/lib/format";

export type Phase = "early" | "earlyMid" | "mid" | "midLate" | "late";

export type PhaseSignature = {
  key: string;
  /**
   * Headline composition shown by default — the top 3 tokens that
   * defined this cluster. Each ``count`` is the MEDIAN across the
   * games in the bucket (not a single sample), and ``sampleCount``
   * mirrors the bucket's game count so the UI can show "12/15 games"
   * confidence inline if it wants.
   */
  units: Array<{ token: string; count: number; sampleCount?: number }>;
  /**
   * Every non-worker unit observed in games matching this bucket
   * (capped server-side). Powers the "show all units" expansion so
   * roach + ravager mixes aren't truncated out of view. Each
   * ``count`` is again the median across games in the bucket.
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

export type PhaseCompositionTabsProps = {
  sampleSize: Record<Phase, number>;
  perPhase: Record<Phase, PhaseCompositionRow>;
  onSignatureClick?: (sampleGameIds: string[]) => void;
  showTechRow?: boolean;
  /**
   * Optional initial tab. When the requested phase has zero samples
   * the component falls back to the first reached phase, so callers
   * can safely set this without disabled-tab footguns.
   */
  preferredPhase?: Phase;
};

const PHASE_ORDER: Phase[] = ["early", "earlyMid", "mid", "midLate", "late"];

const PHASE_LABELS: Record<Phase, string> = {
  early: "Early",
  earlyMid: "Early/Mid",
  mid: "Mid",
  midLate: "Mid/Late",
  late: "Late",
};

// Short labels used below the md breakpoint where the full names
// wrap awkwardly inside the horizontally-scrolling tab row.
const PHASE_SHORT_LABELS: Record<Phase, string> = {
  early: "Early",
  earlyMid: "E/Mid",
  mid: "Mid",
  midLate: "M/Late",
  late: "Late",
};

export function PhaseCompositionTabs({
  sampleSize,
  perPhase,
  onSignatureClick,
  showTechRow = true,
  preferredPhase,
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

  // Auto-scroll the active tab into view when the user picks it on
  // mobile (where the tab row is horizontally scrollable). On desktop
  // the row never overflows so this is a no-op.
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

  return (
    <div className="space-y-4" data-testid="phase-composition-tabs">
      <div
        role="tablist"
        aria-label="Phase compositions"
        aria-orientation="horizontal"
        // Horizontal scroll with snap on mobile so a phone shows the
        // active tab without truncating the rest. `flex-wrap` is
        // suppressed by `flex-nowrap` here — letting tabs wrap onto
        // multiple rows breaks the snap contract.
        className="-mx-1 flex snap-x snap-mandatory items-center gap-1 overflow-x-auto px-1 py-0.5 scrollbar-thin md:flex-wrap md:overflow-visible"
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
              className={[
                "inline-flex min-h-[36px] shrink-0 snap-start items-center gap-2 rounded-md border px-3 py-1.5 text-caption transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                selected
                  ? "border-accent bg-accent/15 text-accent"
                  : disabled
                    ? "cursor-not-allowed border-border text-text-dim"
                    : "border-border bg-bg-surface text-text-muted hover:bg-bg-elevated hover:text-text",
              ].join(" ")}
            >
              <span className="font-medium" data-testid="phase-tab-label">
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
                  "tabular-nums",
                  selected
                    ? "text-accent/80"
                    : disabled
                      ? "text-text-dim"
                      : "text-text-muted",
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
      >
        {renderActiveBody({
          activeRow,
          activeSamples,
          signatures,
          onSignatureClick,
          showTechRow,
          phase: active,
        })}
      </div>
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
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
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
        // Tech timeline is dense; hidden below md per the responsive
        // contract — mobile shows the per-phase median timings card
        // already.
        <div className="hidden md:block">
          <TechTimeline tech={activeRow.tech} />
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
  const wrText =
    total > 0 ? `${signature.wins}–${signature.losses}` : "—";
  const wr = signature.winRate;
  const interactive = !!onClick && signature.sampleGameIds.length > 0;

  const head = signature.units;
  const all = signature.fullComposition ?? signature.units;
  // Extras = full minus tokens already shown in the headline so the
  // expansion doesn't repeat the leading icons.
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
      className="grid grid-cols-2 gap-2 border-t border-border pt-2 sm:grid-cols-3"
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
      className="relative inline-flex h-9 w-9 items-center justify-center rounded bg-bg-elevated md:h-10 md:w-10"
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

function TechTimeline({ tech }: { tech: PhaseTechRow[] }) {
  const { minBound, span } = useMemo(() => {
    if (!tech || tech.length === 0) return { minBound: 0, span: 1 };
    let lo = Infinity;
    let hi = -Infinity;
    for (const t of tech) {
      if (t.p25 < lo) lo = t.p25;
      if (t.p75 > hi) hi = t.p75;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      return { minBound: 0, span: 1 };
    }
    if (hi === lo) return { minBound: lo, span: 1 };
    return { minBound: lo, span: hi - lo };
  }, [tech]);

  if (!tech || tech.length === 0) return null;

  const toPct = (sec: number) =>
    Math.max(0, Math.min(100, ((sec - minBound) / span) * 100));

  return (
    <div
      className="space-y-1"
      data-testid="tech-timeline"
    >
      <div className="flex items-baseline justify-between text-[10px] uppercase tracking-wider text-text-dim">
        <span>Tech timeline</span>
        <span className="font-mono tabular-nums">
          {fmtMinutes(minBound)} – {fmtMinutes(minBound + span)}
        </span>
      </div>
      <div className="relative h-8 w-full rounded-md border border-border bg-bg-elevated">
        {tech.map((t) => {
          const left = toPct(t.medianFirstSeen);
          const bandLeft = toPct(t.p25);
          const bandWidth = Math.max(0, toPct(t.p75) - bandLeft);
          const tooltip =
            `${t.token}: ${t.sampleCount} game${t.sampleCount === 1 ? "" : "s"}, ` +
            `median ${fmtMinutes(t.medianFirstSeen)} ` +
            `(p25-p75 ${fmtMinutes(t.p25)} – ${fmtMinutes(t.p75)})`;
          return (
            <div
              key={t.token}
              className="absolute inset-y-0"
              style={{ left: 0, right: 0 }}
              data-testid="tech-marker"
              data-token={t.token}
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
                  kind="building"
                  size={20}
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
