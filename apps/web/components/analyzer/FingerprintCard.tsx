"use client";

import { useEffect, useState } from "react";
import { ChevronDown, CircleHelp, Fingerprint } from "lucide-react";
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
} from "recharts";
import { useApi } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";

/**
 * Skill Fingerprint is intentionally self-explanatory: the radar is a
 * quick visual, while the signal cards and disclosure carry the real
 * meaning. The API still owns the scoring and playstyle decision table;
 * the copy below mirrors that contract in plain language.
 */

type FingerprintAxis = {
  key: string;
  label: string;
  percentile: number | null;
  value: number | null;
};

type FingerprintData = {
  matchup: string;
  band: { leagueId: number; label: string } | null;
  games: number;
  axes: FingerprintAxis[];
  playstyle: string;
};

type FingerprintResp = { fingerprint: FingerprintData };

type RaceLetter = "P" | "T" | "Z";

type AxisMeta = {
  label: string;
  short: string;
  detail: string;
  scale: string;
};

type PlaystyleDefinition = {
  name: string;
  meaning: string;
  rule: string;
};

const RACE_LETTERS: ReadonlyArray<RaceLetter> = ["P", "T", "Z"];

const RACE_NAMES: Record<RaceLetter, string> = {
  P: "Protoss",
  T: "Terran",
  Z: "Zerg",
};

const PROFILE_AXIS_KEYS = [
  "macro",
  "mechanics",
  "spending",
  "consistency",
  "aggression",
] as const;

const AXIS_KEYS = [...PROFILE_AXIS_KEYS, "ladder"] as const;

const AXIS_META: Record<(typeof AXIS_KEYS)[number], AxisMeta> = {
  macro: {
    label: "Macro",
    short: "Economy and production execution from your replay macro score.",
    detail:
      "Compares each game's macro score with similar games. The score rewards efficient spending and race-specific macro while accounting for supply blocks and resource float.",
    scale: "Higher means cleaner economy and production execution.",
  },
  mechanics: {
    label: "Mechanics",
    short: "Your actions per minute compared with similar games.",
    detail:
      "Uses APM as an activity signal. A higher result means more actions per minute; it does not claim that every action was useful.",
    scale: "Higher means more in-game activity.",
  },
  spending: {
    label: "Spending",
    short: "How efficiently you turn income into units, tech, and production.",
    detail:
      "Uses Spending Quotient (SPQ), which rewards consistently converting available resources instead of leaving a large bank unused.",
    scale: "Higher means more efficient resource conversion.",
  },
  consistency: {
    label: "Consistency",
    short: "How steady your macro score stays from game to game.",
    detail:
      "This is a personal stability score based on the variation in your macro scores. It compares you with your own recent games, not with the benchmark group.",
    scale: "100 is most stable. This signal is a score, not a percentile.",
  },
  aggression: {
    label: "Game tempo",
    short: "How early your games finish compared with similar games.",
    detail:
      "Uses game length as a pace signal: shorter games score higher. It cannot tell who attacked first, so an early loss can also raise this result.",
    scale: "Higher means your games tend to end sooner.",
  },
  ladder: {
    label: "MMR percentile",
    short:
      "Your Matchmaking Rating (MMR) compared with this benchmark group.",
    detail:
      "MMR is StarCraft II's matchmaking rating. It is shown separately as competitive context because rating describes the level you play at, not how you play.",
    scale: "It is not a radar signal and does not affect your playstyle label.",
  },
};

/** First-match order mirrors derivePlaystyle in the API service. */
const PLAYSTYLE_DEFINITIONS: ReadonlyArray<PlaystyleDefinition> = [
  {
    name: "Complete Player",
    meaning: "Strong results across every signal currently available.",
    rule: "At least 4 playstyle signals are available and every available playstyle signal scores 65 or higher. MMR is ignored.",
  },
  {
    name: "All-in Gambler",
    meaning: "A fast-game profile paired with lower macro results.",
    rule: "Game tempo is 70+ and Macro is below 40.",
  },
  {
    name: "Greedy Macro Player",
    meaning: "A macro-first profile whose games usually run longer.",
    rule: "Macro is 70+ and Game tempo is below 40.",
  },
  {
    name: "Tempo Attacker",
    meaning: "Fast games paired with high mechanical activity.",
    rule: "Game tempo is 65+ and Mechanics is 65+.",
  },
  {
    name: "Economic Engine",
    meaning: "Strong spending efficiency backed by solid macro.",
    rule: "Spending is 70+ and Macro is 55+.",
  },
  {
    name: "Busy Hands, Idle Bank",
    meaning: "High APM, but resources are not converted as efficiently.",
    rule: "Mechanics is 70+ and Spending is below 40.",
  },
  {
    name: "Metronome",
    meaning: "Steady macro across games, usually at a measured pace.",
    rule: "Consistency is 70+ and Game tempo is below 55.",
  },
  {
    name: "Coin-Flip Player",
    meaning: "Macro results vary substantially from game to game.",
    rule: "Consistency is below 35.",
  },
  {
    name: "Jack of All Trades",
    meaning: "A mixed profile without one dominant measured tendency.",
    rule: "Fallback when none of the rules above matches the available signals.",
  },
];

const LS_MATCHUP = "analyzer.fingerprint.matchup";

function readStoredMatchup(): string {
  if (typeof window === "undefined") return "PvZ";
  try {
    const v = window.localStorage.getItem(LS_MATCHUP);
    return v && /^[PTZ]v[PTZ]$/.test(v) ? v : "PvZ";
  } catch {
    return "PvZ";
  }
}

/** 72 -> "72nd", 41 -> "41st", 100 -> "100th". */
function ordinal(n: number): string {
  const rem = n % 100;
  if (rem >= 11 && rem <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function FingerprintCard() {
  const [matchup, setMatchup] = useState<string>(readStoredMatchup);
  useEffect(() => {
    try {
      window.localStorage.setItem(LS_MATCHUP, matchup);
    } catch {
      /* non-fatal */
    }
  }, [matchup]);

  const { data, isLoading, error } = useApi<FingerprintResp>(
    `/v1/me/fingerprint?matchup=${matchup}`,
    { revalidateOnFocus: false },
  );

  const my = matchup[0] as RaceLetter;
  const vs = matchup[2] as RaceLetter;
  const fp = data?.fingerprint;
  const notEnough = error?.status === 404;

  return (
    <Card padded={false} aria-labelledby="skill-fingerprint-title">
      <Card.Header className="flex-col items-stretch gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <h3
            id="skill-fingerprint-title"
            className="text-caption font-semibold text-text"
          >
            Skill fingerprint
          </h3>
          <p className="mt-0.5 text-micro text-text-dim">
            Your recent 1v1 profile
          </p>
        </div>
        <MatchupPicker
          my={my}
          vs={vs}
          onChange={(m, v) => setMatchup(`${m}v${v}`)}
        />
      </Card.Header>

      <Card.Body>
        {isLoading ? (
          <Skeleton rows={3} />
        ) : notEnough ? (
          <EmptyStatePanel
            size="md"
            icon={<Fingerprint className="h-5 w-5" aria-hidden />}
            title={`Not enough ${matchup} games yet`}
            description={`Play at least 10 ${matchup} 1v1 games and your fingerprint will appear here. It uses up to your 50 most recent games in this matchup.`}
          />
        ) : error ? (
          <EmptyStatePanel
            size="sm"
            title="Couldn't load your fingerprint"
            description="Try again in a moment."
          />
        ) : fp ? (
          <FingerprintBody fp={fp} />
        ) : null}
      </Card.Body>
    </Card>
  );
}

function FingerprintBody({ fp }: { fp: FingerprintData }) {
  const profileAxes = fp.axes.filter((axis) => axis.key !== "ladder");
  const visible = profileAxes.filter((axis) => axis.percentile != null);
  const missing = profileAxes.filter((axis) => axis.percentile == null);
  const mmr = fp.axes.find((axis) => axis.key === "ladder") ?? null;
  const radarData = visible.map((axis) => ({
    axis: axisMeta(axis).label,
    score: axis.percentile as number,
  }));
  const style = playstyleDefinition(fp.playstyle);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(240px,0.9fr)_minmax(300px,1.25fr)]">
        <section className="flex flex-col justify-center" aria-labelledby="playstyle-heading">
          <span className="text-micro uppercase tracking-wider text-text-dim">
            Estimated playstyle
          </span>
          <h4
            id="playstyle-heading"
            className="mt-1 font-display text-xl font-bold text-text"
          >
            {fp.playstyle}
          </h4>
          <p className="mt-1 text-caption leading-relaxed text-text-muted">
            {style.meaning}
          </p>

          <div className="mt-3 rounded-lg border border-border bg-bg-elevated/50 p-3">
            <p className="text-micro font-semibold uppercase tracking-wider text-text-dim">
              Why this label
            </p>
            <p className="mt-1 text-caption leading-relaxed text-text">
              {currentPlaystyleReason(fp)}
            </p>
          </div>

          <div className="mt-3 space-y-1 text-micro leading-relaxed text-text-dim">
            <p>
              Based on your {fp.games} most recent {fp.matchup} 1v1 replay
              {fp.games === 1 ? "" : "s"}.
            </p>
            <p>
              {fp.band
                ? `Benchmark: ${fp.matchup} games against mostly ${fp.band.label} opponents.`
                : "No opponent-league benchmark is available yet."}
            </p>
          </div>

          {mmr?.percentile != null ? (
            <div className="mt-3 border-l-2 border-accent pl-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-micro font-semibold uppercase tracking-wider text-text-dim">
                  Competitive context
                </p>
                <p className="font-display text-caption font-bold tabular-nums text-accent">
                  {ordinal(mmr.percentile)} MMR percentile
                </p>
              </div>
              <p className="mt-1 text-micro leading-relaxed text-text-muted">
                Matchmaking Rating shows the level you play at, not how you
                play. {rawValueLabel(mmr)}. It is kept outside the graph and
                does not affect your playstyle label.
              </p>
            </div>
          ) : null}
        </section>

        {radarData.length >= 3 ? (
          <figure className="mx-auto w-full min-w-0 max-w-lg">
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-2">
              <h4 className="text-caption font-semibold text-text">Profile shape</h4>
              <span className="text-micro font-medium text-text-dim">
                Center 0 · Edge 100
              </span>
            </div>
            <div
              aria-hidden="true"
              data-testid="fingerprint-radar"
              className="h-[210px] w-full min-w-0 sm:h-[285px]"
            >
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart
                  data={radarData}
                  outerRadius="74%"
                  margin={{ top: 24, right: 42, bottom: 24, left: 42 }}
                >
                  <PolarGrid stroke="rgb(var(--border-strong))" />
                  <PolarAngleAxis
                    dataKey="axis"
                    tick={{ fill: "rgb(var(--text-muted))", fontSize: 12 }}
                    tickLine={false}
                  />
                  <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
                  <Radar
                    dataKey="score"
                    stroke="rgb(var(--accent-cyan))"
                    strokeWidth={2}
                    fill="rgb(var(--accent-cyan))"
                    fillOpacity={0.25}
                    isAnimationActive={false}
                  />
                </RadarChart>
              </ResponsiveContainer>
            </div>
            <figcaption className="rounded-lg border border-border bg-bg-elevated/35 px-3 py-2 text-micro leading-relaxed text-text-muted">
              {radarData.length === 3
                ? "Three available signals make this a triangle. "
                : `${radarData.length} available signals make this outline. `}
              Each corner is one signal: closer to the edge means a higher
              score. The shape compares tendencies; it is not an overall grade.
            </figcaption>
          </figure>
        ) : (
          <div className="flex min-h-32 items-center justify-center rounded-lg border border-dashed border-border bg-bg-elevated/30 p-5 text-center text-caption text-text-muted">
            A radar appears when at least three signals have enough data.
          </div>
        )}
      </div>

      <section className="border-t border-border pt-4" aria-labelledby="signals-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h4 id="signals-heading" className="text-body font-semibold text-text">
              What the signals mean
            </h4>
            <p className="mt-0.5 text-micro text-text-dim">
              The chart is a summary; these values are the score behind it.
            </p>
          </div>
          <span className="rounded-full border border-border bg-bg-elevated px-2.5 py-1 text-micro font-semibold text-text-muted">
            {visible.length} of {profileAxes.length} available
          </span>
        </div>

        <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((axis) => (
            <AxisSummary key={axis.key} axis={axis} />
          ))}
        </dl>

        {missing.length > 0 ? (
          <p className="mt-3 text-caption leading-relaxed text-text-dim">
            <span className="font-semibold text-text-muted">Not shown:</span>{" "}
            {formatList(missing.map((axis) => axisMeta(axis).label))}. Your recent
            replays or the comparison group do not have enough usable data yet.
            Missing signals are ignored, never scored as zero.
          </p>
        ) : null}
      </section>

      <MethodologyDetails fp={fp} />
    </div>
  );
}

function AxisSummary({ axis }: { axis: FingerprintAxis }) {
  const meta = axisMeta(axis);
  const percentile = axis.percentile as number;
  const raw = rawValueLabel(axis);
  return (
    <div className="rounded-lg border border-border bg-bg-elevated/35 p-3">
      <dt className="flex items-start justify-between gap-3 font-semibold text-text">
        <span>{meta.label}</span>
        <span className="whitespace-nowrap font-display text-body font-bold tabular-nums text-accent">
          {axis.key === "consistency"
            ? `${percentile}/100`
            : `${ordinal(percentile)} percentile`}
        </span>
      </dt>
      <dd className="mt-1 text-caption leading-relaxed text-text-muted">
        {meta.short}
      </dd>
      {raw ? (
        <dd className="mt-2 text-micro font-medium tabular-nums text-text-dim">
          {raw}
        </dd>
      ) : null}
    </div>
  );
}

function MethodologyDetails({ fp }: { fp: FingerprintData }) {
  return (
    <details className="group rounded-lg border border-border bg-bg-elevated/25">
      <summary className="flex min-h-[48px] cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-caption font-semibold text-text transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <CircleHelp className="h-4 w-4 flex-none text-accent" aria-hidden />
        <span>Calculation and playstyle guide</span>
        <ChevronDown
          className="ml-auto h-4 w-4 flex-none text-text-dim transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>

      <div className="space-y-5 border-t border-border px-3 py-4 sm:px-4">
        <section aria-labelledby="calculation-heading">
          <h5 id="calculation-heading" className="text-caption font-semibold text-text">
            How the fingerprint is calculated
          </h5>
          <p className="mt-1 text-caption leading-relaxed text-text-muted">
            It uses your latest 10–50 {fp.matchup} 1v1 replays. With the
            exception of Consistency, each playstyle signal is a percentile
            built by comparing each replay with comparable {fp.matchup} games
            against mostly {fp.band?.label ?? "the same league of"} opponents.
            The fingerprint always uses this recent-game window and is
            independent of dashboard filters.
          </p>

          <dl className="mt-3 grid grid-cols-1 gap-x-5 gap-y-3 md:grid-cols-2">
            {PROFILE_AXIS_KEYS.map((key) => {
              const meta = AXIS_META[key];
              return (
                <div key={key}>
                  <dt className="text-caption font-semibold text-text">
                    {meta.label}
                  </dt>
                  <dd className="mt-0.5 text-micro leading-relaxed text-text-muted">
                    {meta.detail} {meta.scale}
                  </dd>
                </div>
              );
            })}
          </dl>

          <div className="mt-4 rounded-lg border border-accent/30 bg-accent/5 p-3">
            <p className="text-caption font-semibold text-text">
              Competitive context · {AXIS_META.ladder.label}
            </p>
            <p className="mt-1 text-micro leading-relaxed text-text-muted">
              {AXIS_META.ladder.detail} {AXIS_META.ladder.scale}
            </p>
          </div>
        </section>

        <section className="border-t border-border pt-4" aria-labelledby="labels-heading">
          <h5 id="labels-heading" className="text-caption font-semibold text-text">
            What each playstyle label means
          </h5>
          <p className="mt-1 text-micro leading-relaxed text-text-dim">
            Rules are checked in this order; the first match becomes the label.
            A rule that needs a missing signal is skipped. MMR is never part of
            these rules.
          </p>
          <ol className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
            {PLAYSTYLE_DEFINITIONS.map((definition) => {
              const current = definition.name === fp.playstyle;
              return (
                <li
                  key={definition.name}
                  aria-current={current ? "true" : undefined}
                  className={[
                    "rounded-lg border p-3",
                    current
                      ? "border-accent bg-accent/5"
                      : "border-border bg-bg-surface/50",
                  ].join(" ")}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-caption font-semibold text-text">
                      {definition.name}
                    </span>
                    {current ? (
                      <span className="rounded-full bg-accent/15 px-2 py-0.5 text-micro font-semibold text-accent">
                        Your label
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-micro leading-relaxed text-text-muted">
                    {definition.meaning}
                  </p>
                  <p className="mt-1 text-micro leading-relaxed text-text-dim">
                    <span className="font-semibold">Rule:</span> {definition.rule}
                  </p>
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    </details>
  );
}

function currentPlaystyleReason(fp: FingerprintData): string {
  const available = fp.axes.filter(
    (axis) => axis.key !== "ladder" && axis.percentile != null,
  );
  const score = (key: string) =>
    fp.axes.find((axis) => axis.key === key)?.percentile ?? null;
  const n = (key: string) => score(key) ?? "unavailable";

  switch (fp.playstyle) {
    case "Complete Player": {
      const lowest = available
        .slice()
        .sort((a, b) => (a.percentile as number) - (b.percentile as number))[0];
      return lowest
        ? `${available.length} signals are available and every one scores 65 or higher; the lowest is ${axisMeta(lowest).label} at ${lowest.percentile}.`
        : playstyleDefinition(fp.playstyle).rule;
    }
    case "All-in Gambler":
      return `Game tempo scored ${n("aggression")} (70+) while Macro scored ${n("macro")} (below 40).`;
    case "Greedy Macro Player":
      return `Macro scored ${n("macro")} (70+) while Game tempo scored ${n("aggression")} (below 40).`;
    case "Tempo Attacker":
      return `Game tempo scored ${n("aggression")} and Mechanics scored ${n("mechanics")}; both crossed 65.`;
    case "Economic Engine":
      return `Spending scored ${n("spending")} (70+) and Macro scored ${n("macro")} (55+).`;
    case "Busy Hands, Idle Bank":
      return `Mechanics scored ${n("mechanics")} (70+) while Spending scored ${n("spending")} (below 40).`;
    case "Metronome":
      return `Consistency scored ${n("consistency")} (70+) while Game tempo stayed below 55 at ${n("aggression")}.`;
    case "Coin-Flip Player":
      return `Consistency scored ${n("consistency")}, below the 35-point stability threshold.`;
    case "Jack of All Trades":
      return `No more specific tendency crossed its rule across the ${available.length} available signal${available.length === 1 ? "" : "s"}.`;
    default:
      return playstyleDefinition(fp.playstyle).rule;
  }
}

function playstyleDefinition(name: string): PlaystyleDefinition {
  return (
    PLAYSTYLE_DEFINITIONS.find((definition) => definition.name === name) ?? {
      name,
      meaning: "A profile estimated from the available recent-game signals.",
      rule: "The server selected this label from the available signals.",
    }
  );
}

function axisMeta(axis: Pick<FingerprintAxis, "key" | "label">): AxisMeta {
  if (axis.key in AXIS_META) {
    return AXIS_META[axis.key as keyof typeof AXIS_META];
  }
  return {
    label: axis.label,
    short: "A recent-game performance signal.",
    detail: "This signal is calculated from your recent replays.",
    scale: "Higher values indicate a higher score.",
  };
}

function rawValueLabel(axis: FingerprintAxis): string | null {
  if (axis.value == null || !Number.isFinite(axis.value)) return null;
  switch (axis.key) {
    case "macro":
      return `Average macro score ${formatNumber(axis.value, 1)}`;
    case "mechanics":
      return `Average ${Math.round(axis.value).toLocaleString()} APM`;
    case "spending":
      return `Average SPQ ${formatNumber(axis.value, 1)}`;
    case "consistency":
      return `Macro-score spread ${formatNumber(axis.value, 1)} points`;
    case "aggression":
      return `${Math.round(axis.value)}% ended before 8:00`;
    case "ladder":
      return `Average MMR ${Math.round(axis.value).toLocaleString()}`;
    default:
      return `Average ${formatNumber(axis.value, 1)}`;
  }
}

function formatNumber(value: number, places: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : places,
    maximumFractionDigits: places,
  });
}

function formatList(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "None";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

/** Compact two-sided matchup picker with visible group labels. */
function MatchupPicker({
  my,
  vs,
  onChange,
}: {
  my: RaceLetter;
  vs: RaceLetter;
  onChange: (my: RaceLetter, vs: RaceLetter) => void;
}) {
  return (
    <div
      aria-label="Fingerprint matchup"
      className="flex max-w-full items-end gap-2 overflow-x-auto pb-1 sm:ml-auto sm:pb-0"
    >
      <ChipGroup
        label="You play"
        side="I play"
        active={my}
        onPick={(letter) => onChange(letter, vs)}
      />
      <span className="mb-3 text-micro font-bold text-text-dim">vs</span>
      <ChipGroup
        label="Opponent"
        side="Versus"
        active={vs}
        onPick={(letter) => onChange(my, letter)}
      />
    </div>
  );
}

function ChipGroup({
  label,
  side,
  active,
  onPick,
}: {
  label: string;
  side: string;
  active: RaceLetter;
  onPick: (letter: RaceLetter) => void;
}) {
  return (
    <fieldset className="flex-none">
      <legend className="mb-1 text-micro font-medium text-text-dim">{label}</legend>
      <div className="flex items-center gap-1">
        {RACE_LETTERS.map((letter) => {
          const isActive = letter === active;
          return (
            <button
              key={letter}
              type="button"
              aria-label={`${side} ${RACE_NAMES[letter]}`}
              aria-pressed={isActive}
              onClick={() => onPick(letter)}
              className={[
                "flex h-11 w-11 items-center justify-center rounded-lg border text-caption font-bold",
                "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                isActive
                  ? "border-accent bg-accent/15 text-accent"
                  : "border-border bg-bg-elevated text-text-muted hover:bg-bg-surface hover:text-text",
              ].join(" ")}
            >
              {letter}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
