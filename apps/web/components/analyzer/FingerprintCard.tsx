"use client";

import { useEffect, useState } from "react";
import { ChevronDown, CircleHelp, Fingerprint } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";

type FingerprintAxis = {
  key: AxisKey | string;
  label: string;
  position: number | null;
  value: number | null;
  category: string | null;
  categoryLabel: string | null;
  sampleSize: number;
};

type FingerprintData = {
  matchup: string;
  race: string;
  games: number;
  windowGames: number;
  axes: FingerprintAxis[];
  playstyle: string;
  archetype: {
    key: string;
    name: string;
    description: string;
    complete: boolean;
  };
  buildOrders: Array<{ name: string; games: number }>;
  matchupWinRates: MatchupWinRate[];
  matchupSummary: {
    spread: number | null;
    leaderGap: number | null;
    weakGap: number | null;
    strongestMatchup: string | null;
    weakestMatchup: string | null;
  };
};

type FingerprintResp = { fingerprint: FingerprintData };

type RaceLetter = "P" | "T" | "Z";
type AxisKey = "repertoire" | "pace" | "matchup_balance";

type MatchupWinRate = {
  matchup: string;
  games: number;
  decidedGames: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number | null;
};

type AxisMeta = {
  title: string;
  description: string;
  leftLabel: string;
  centerLabel: string;
  rightLabel: string;
  scale: string;
  trackClass: string;
};

type MatchupCategory =
  | "specialist"
  | "matchup_flex"
  | "universalist"
  | "blind_spot";

type CatalogRow = {
  repertoire: "grinder" | "adaptive" | "creative";
  pace: "cheeser" | "standard" | "late_game";
  names: Record<MatchupCategory, string>;
};

const RACE_LETTERS: ReadonlyArray<RaceLetter> = ["P", "T", "Z"];

const RACE_NAMES: Record<RaceLetter, string> = {
  P: "Protoss",
  T: "Terran",
  Z: "Zerg",
};

const AXIS_ORDER: ReadonlyArray<AxisKey> = [
  "repertoire",
  "pace",
  "matchup_balance",
];

const AXIS_META: Record<AxisKey, AxisMeta> = {
  repertoire: {
    title: "Build variety",
    description: "How many different build orders you use in this matchup.",
    leftLabel: "Consistent Grinder",
    centerLabel: "Adaptive Strategist",
    rightLabel: "Creative Genius",
    scale: "1–2 builds · 3–9 builds · 10+ builds",
    trackClass: "from-text-dim/45 via-accent/45 to-accent-cyan/70",
  },
  pace: {
    title: "Average game length",
    description:
      "Whether your games usually end early, in the mid game, or in the late game.",
    leftLabel: "Cheeser",
    centerLabel: "Flexible Pacer",
    rightLabel: "Late-Game Specialist",
    scale: "5:00 or less · over 5:00 and under 15:00 · 15:00 or more",
    trackClass: "from-warning/60 via-accent/40 to-accent-cyan/70",
  },
  matchup_balance: {
    title: "Matchup strengths",
    description:
      "Compares your win rates across all three matchups. A clear strength pulls left; one weak matchup pulls right.",
    leftLabel: "Matchup Specialist",
    centerLabel: "Completely Balanced",
    rightLabel: "Matchup Blind Spot",
    scale:
      "10%+ strength · all three within 5% (within 1% = balanced) · 10%+ weakness",
    trackClass: "from-accent-cyan/70 via-accent/30 to-danger/65",
  },
};

const MATCHUP_CATEGORY_LABELS: Record<MatchupCategory, string> = {
  specialist: "Specialist",
  matchup_flex: "Matchup flex",
  universalist: "Universalist",
  blind_spot: "Blind spot",
};

const ARCHETYPE_CATALOG: ReadonlyArray<CatalogRow> = [
  { repertoire: "grinder", pace: "cheeser", names: { specialist: "Precision Ambusher", matchup_flex: "Calculated Raider", universalist: "Three-Matchup Punisher", blind_spot: "Two-Front Raider" } },
  { repertoire: "grinder", pace: "standard", names: { specialist: "Matchup Technician", matchup_flex: "Disciplined Operator", universalist: "Reliable All-Rounder", blind_spot: "Two-Front Technician" } },
  { repertoire: "grinder", pace: "late_game", names: { specialist: "Fortress Specialist", matchup_flex: "Endurance Engineer", universalist: "Macro Machine", blind_spot: "Fault-Line Fortress" } },
  { repertoire: "adaptive", pace: "cheeser", names: { specialist: "Counter-Build Hunter", matchup_flex: "Tempo Trickster", universalist: "Opening Opportunist", blind_spot: "Two-Front Trapper" } },
  { repertoire: "adaptive", pace: "standard", names: { specialist: "Strategic Specialist", matchup_flex: "Adaptive Competitor", universalist: "Versatile Tactician", blind_spot: "Strategic Soft Spot" } },
  { repertoire: "adaptive", pace: "late_game", names: { specialist: "Endgame Counterpuncher", matchup_flex: "Scaling Strategist", universalist: "Endgame Generalist", blind_spot: "Scaling Soft Spot" } },
  { repertoire: "creative", pace: "cheeser", names: { specialist: "Lab-Crafted Ambusher", matchup_flex: "Chaos Architect", universalist: "Wildcard Raider", blind_spot: "Two-Front Wildcard" } },
  { repertoire: "creative", pace: "standard", names: { specialist: "Matchup Inventor", matchup_flex: "Build Lab Explorer", universalist: "Creative All-Rounder", blind_spot: "Creative Soft Spot" } },
  { repertoire: "creative", pace: "late_game", names: { specialist: "Endgame Innovator", matchup_flex: "Late-Game Visionary", universalist: "Strategic Polymath", blind_spot: "Endgame Soft Spot" } },
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
            Your recent 1v1 playstyle
          </p>
        </div>
        <MatchupPicker
          my={my}
          vs={vs}
          onChange={(nextMy, nextVs) => setMatchup(`${nextMy}v${nextVs}`)}
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
  const axes = new Map(fp.axes.map((axis) => [axis.key, axis]));
  const availableAxes = AXIS_ORDER.filter((key) => axisAvailable(axes.get(key)));
  const repertoire = axes.get("repertoire");
  const pace = axes.get("pace");
  const matchupShape = axes.get("matchup_balance");

  return (
    <div className="space-y-5">
      <section
        className="overflow-hidden rounded-xl border border-accent/35 bg-gradient-to-br from-accent/10 via-bg-surface to-bg-elevated/70 p-4 sm:p-5"
        aria-labelledby="playstyle-heading"
      >
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)] lg:items-end">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="overline text-accent-cyan">Your archetype</span>
              <span
                className={[
                  "rounded-full border px-2.5 py-1 text-micro font-semibold",
                  fp.archetype.complete
                    ? "border-accent/45 bg-accent/10 text-accent-cyan"
                    : "border-warning/45 bg-warning/10 text-warning",
                ].join(" ")}
              >
                {fp.archetype.complete
                  ? "Complete profile"
                  : `${availableAxes.length} of 3 tracks ready`}
              </span>
            </div>
            <h4
              id="playstyle-heading"
              className="mt-2 font-display text-h2 font-bold text-text"
            >
              {fp.archetype.name || fp.playstyle}
            </h4>
            <p className="mt-2 max-w-2xl text-body leading-relaxed text-text-muted">
              {fp.archetype.description}
            </p>
            <p className="mt-3 text-micro leading-relaxed text-text-dim">
              Based on {fp.games.toLocaleString()} recent {fp.matchup} 1v1 replay
              {fp.games === 1 ? "" : "s"}, using up to your latest {fp.windowGames}.
            </p>
          </div>

          <dl className="grid grid-cols-2 gap-2">
            <HeroStat label="Matchup" value={fp.matchup} />
            <HeroStat
              label="Build orders"
              value={
                axisAvailable(repertoire)
                  ? fp.buildOrders.length.toLocaleString()
                  : "Still forming"
              }
            />
            <HeroStat
              label="Avg game"
              value={axisAvailable(pace) ? formatDuration(pace.value) : "Still forming"}
            />
            <HeroStat
              label="Matchup profile"
              value={
                axisAvailable(matchupShape)
                  ? matchupShape.categoryLabel ?? "Still forming"
                  : "Still forming"
              }
            />
          </dl>
        </div>
      </section>

      <section aria-labelledby="spectra-heading">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h4 id="spectra-heading" className="text-body font-semibold text-text">
              Your three playstyle spectra
            </h4>
            <p className="mt-0.5 text-micro text-text-dim">
              Each marker comes directly from the recent replays shown below it.
            </p>
          </div>
          <span className="rounded-full border border-border bg-bg-elevated px-2.5 py-1 text-micro font-semibold text-text-muted">
            {availableAxes.length} of 3 tracks ready
          </span>
        </div>
        <div className="mt-3 space-y-3">
          {AXIS_ORDER.map((key) => (
            <SpectrumRow key={key} axisKey={key} axis={axes.get(key)} fp={fp} />
          ))}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]">
        <MatchupEvidence fp={fp} />
        <BuildEvidence fp={fp} />
      </div>
      <MethodologyDetails fp={fp} />
      <ArchetypeCatalog currentKey={fp.archetype.key} />
    </div>
  );
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-bg-surface/70 px-3 py-2.5">
      <dt className="text-micro font-semibold uppercase tracking-wider text-text-dim">
        {label}
      </dt>
      <dd className="mt-1 break-words font-display text-caption font-bold leading-tight tabular-nums text-text">
        {value}
      </dd>
    </div>
  );
}

function SpectrumRow({
  axisKey,
  axis,
  fp,
}: {
  axisKey: AxisKey;
  axis: FingerprintAxis | undefined;
  fp: FingerprintData;
}) {
  const meta = AXIS_META[axisKey];
  const available = axisAvailable(axis);

  return (
    <article
      data-testid={`fingerprint-axis-${axisKey}`}
      className="rounded-xl border border-border bg-bg-elevated/35 p-3.5 sm:p-4"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h5 className="text-caption font-semibold text-text">
            {meta.title}
          </h5>
          <p className="mt-0.5 text-micro leading-relaxed text-text-muted">
            {meta.description}
          </p>
        </div>
        {available && axis ? (
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <span className="rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-micro font-semibold text-accent-cyan">
              {axis.categoryLabel}
            </span>
            <span className="font-display text-caption font-bold tabular-nums text-text">
              {axisValueLabel(axisKey, axis, fp)}
            </span>
          </div>
        ) : (
          <span className="self-start rounded-full border border-border bg-bg-surface px-2.5 py-1 text-micro font-semibold text-text-dim">
            Not enough data
          </span>
        )}
      </div>

      {available && axis ? (
        <>
          <div className="mt-4 px-1">
            <div
              className={`relative h-2.5 rounded-full bg-gradient-to-r ${meta.trackClass}`}
              aria-hidden="true"
            >
              <span className="absolute left-1/2 top-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-text/35" />
              <span
                data-testid={`fingerprint-marker-${axisKey}`}
                className="absolute top-1/2 h-5 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg bg-text shadow-hard"
                style={{ left: `${clampPosition(axis.position)}%` }}
              />
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-micro font-medium leading-tight text-text-muted">
              <span>{meta.leftLabel}</span>
              <span className="text-center">{meta.centerLabel}</span>
              <span className="text-right">{meta.rightLabel}</span>
            </div>
            <p className="mt-2 text-center text-micro tabular-nums text-text-dim">
              {meta.scale}
            </p>
          </div>
          <p className="mt-3 border-t border-border pt-3 text-caption leading-relaxed text-text-muted">
            {axisEvidence(axisKey, axis, fp)}
          </p>
        </>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-4 text-caption leading-relaxed text-text-dim">
          {missingAxisEvidence(axisKey, axis, fp)} Until then, this track stays
          unranked.
        </div>
      )}
    </article>
  );
}

function MatchupEvidence({ fp }: { fp: FingerprintData }) {
  const matchupCategory = fp.axes.find(
    (axis) => axis.key === "matchup_balance",
  )?.category;
  return (
    <section
      className="rounded-xl border border-border bg-bg-elevated/25 p-4"
      aria-labelledby="matchup-evidence-heading"
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h4 id="matchup-evidence-heading" className="text-caption font-semibold text-text">
            Matchup performance
          </h4>
          <p className="mt-0.5 text-micro text-text-dim">
            Your recent win rates in all three matchups.
          </p>
        </div>
        {fp.matchupSummary.spread != null ? (
          <span className="text-micro font-semibold tabular-nums text-text-muted">
            {formatPercentGap(fp.matchupSummary.spread)} between best and worst
          </span>
        ) : null}
      </div>

      {fp.matchupWinRates.length > 0 ? (
        <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {fp.matchupWinRates.map((row) => {
            const strongest =
              matchupCategory === "specialist" &&
              row.matchup === fp.matchupSummary.strongestMatchup;
            const weakest =
              matchupCategory === "blind_spot" &&
              row.matchup === fp.matchupSummary.weakestMatchup;
            return (
              <div
                key={row.matchup}
                className={[
                  "rounded-lg border p-3",
                  strongest
                    ? "border-accent/55 bg-accent/10"
                    : weakest
                      ? "border-danger/35 bg-danger/5"
                      : "border-border bg-bg-surface/55",
                ].join(" ")}
              >
                <dt className="flex items-center justify-between gap-2">
                  <span className="font-display text-caption font-bold text-text">
                    {row.matchup}
                  </span>
                  <span className="text-micro font-semibold tabular-nums text-text-dim">
                    {row.decidedGames} decided
                  </span>
                </dt>
                <dd className="mt-2 font-display text-h4 font-bold tabular-nums text-text">
                  {formatWinRate(row.winRate)}
                </dd>
                <dd className="mt-1 text-micro tabular-nums text-text-muted">
                  {row.wins}W · {row.losses}L
                  {row.ties > 0 ? ` · ${row.ties}T` : ""}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <p className="mt-3 rounded-lg border border-dashed border-border p-4 text-caption text-text-dim">
          Matchup win rates will appear when qualifying games are available.
        </p>
      )}
    </section>
  );
}

function BuildEvidence({ fp }: { fp: FingerprintData }) {
  const preview = fp.buildOrders.slice(0, 8);
  const remaining = fp.buildOrders.length - preview.length;
  return (
    <section
      className="rounded-xl border border-border bg-bg-elevated/25 p-4"
      aria-labelledby="build-evidence-heading"
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h4 id="build-evidence-heading" className="text-caption font-semibold text-text">
            Your recent builds
          </h4>
          <p className="mt-0.5 text-micro text-text-dim">
            Builds detected in your recent {fp.matchup} replays.
          </p>
        </div>
        <span className="text-micro font-semibold tabular-nums text-text-muted">
          {fp.buildOrders.length} distinct
        </span>
      </div>

      {fp.buildOrders.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2">
          {preview.map((build, index) => (
            <li
              key={`${build.name}-${index}`}
              className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-bg-surface/65 px-2.5 py-1.5 text-caption text-text"
            >
              <span className="min-w-0 truncate">{build.name}</span>
              <span className="flex-none rounded-full bg-bg-elevated px-1.5 py-0.5 text-micro font-semibold tabular-nums text-text-dim">
                {build.games}
              </span>
            </li>
          ))}
          {remaining > 0 ? (
            <li className="inline-flex items-center rounded-lg border border-dashed border-border px-2.5 py-1.5 text-caption font-semibold text-text-dim">
              +{remaining} more
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="mt-3 rounded-lg border border-dashed border-border p-4 text-caption leading-relaxed text-text-dim">
          We could not identify a named build in these replays. Unclassified
          games and games that ended too quickly are left out.
        </p>
      )}
    </section>
  );
}

function MethodologyDetails({ fp }: { fp: FingerprintData }) {
  return (
    <details className="group rounded-xl border border-border bg-bg-elevated/25">
      <summary className="flex min-h-[48px] cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 text-caption font-semibold text-text transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <CircleHelp className="h-4 w-4 flex-none text-accent-cyan" aria-hidden />
        <span>How this fingerprint is calculated</span>
        <ChevronDown
          className="ml-auto h-4 w-4 flex-none text-text-dim transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>

      <div className="border-t border-border px-3 py-4 sm:px-4">
        <p className="text-caption leading-relaxed text-text-muted">
          Build variety and average game length use your latest {fp.games}{" "}
          {fp.matchup} 1v1 replays, up to {fp.windowGames}. The matchup-strength
          track compares separate recent windows against Protoss, Terran, and Zerg.
          Each track needs enough games before it receives a rating. Dashboard
          filters do not change these replay windows.
        </p>

        <ol className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <li className="rounded-lg border border-border bg-bg-surface/55 p-3">
            <p className="text-caption font-semibold text-text">1. Build variety</p>
            <p className="mt-1 text-micro leading-relaxed text-text-muted">
              We count how many different named builds you played. One or two
              makes you a Consistent Grinder, three to nine makes you an
              Adaptive Strategist, and 10 or more makes you a Creative Genius.
              Repeating the same build still counts as one build. Replays we
              cannot classify are left out.
            </p>
          </li>
          <li className="rounded-lg border border-border bg-bg-surface/55 p-3">
            <p className="text-caption font-semibold text-text">2. Average game length</p>
            <p className="mt-1 text-micro leading-relaxed text-text-muted">
              We average how long your games last. Five minutes or less makes
              you a Cheeser, 15 minutes or more makes you a Late-Game
              Specialist, and anything between those marks makes you a Flexible
              Pacer. Wins and losses both count. Games under 45 seconds are
              ignored as likely quits or restarts.
            </p>
          </li>
          <li className="rounded-lg border border-border bg-bg-surface/55 p-3">
            <p className="text-caption font-semibold text-text">3. Matchup strengths</p>
            <p className="mt-1 text-micro leading-relaxed text-text-muted">
              We compare your win rates in all three matchups on one track. If
              they are within 5% of each other, your marker stays near the
              middle; within 1% is Completely Balanced. If one matchup is at
              least 10% better than each of the other two, you reach Matchup
              Specialist. If one is at least 10% worse than each of the other
              two, you reach Matchup Blind Spot. Between those marks, the marker
              leans toward your larger strength or weakness. If both ends
              qualify, the larger gap decides; an exact tie goes to Matchup
              Specialist. Replay ties are shown, but only wins and losses count
              toward win rate.
            </p>
          </li>
        </ol>

        <p className="mt-4 rounded-lg border border-accent/25 bg-accent/5 p-3 text-micro leading-relaxed text-text-muted">
          Your archetype name combines your build pool, average game length, and
          matchup strengths. If one track needs more games, your profile stays
          incomplete until the replay data is there.
        </p>
      </div>
    </details>
  );
}

function ArchetypeCatalog({ currentKey }: { currentKey: string }) {
  const matchupCategories: ReadonlyArray<MatchupCategory> = [
    "specialist",
    "matchup_flex",
    "universalist",
    "blind_spot",
  ];

  return (
    <details
      data-testid="fingerprint-archetype-catalog"
      className="group rounded-xl border border-border bg-bg-elevated/25"
    >
      <summary className="flex min-h-[48px] cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 text-caption font-semibold text-text transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <Fingerprint className="h-4 w-4 flex-none text-accent-cyan" aria-hidden />
        <span>All 36 archetypes</span>
        <ChevronDown
          className="ml-auto h-4 w-4 flex-none text-text-dim transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>

      <div className="border-t border-border px-3 py-4 sm:px-4">
        <p className="text-micro leading-relaxed text-text-dim">
          Nine repertoire-and-pace combinations, each with four possible
          matchup shapes. The highlighted entry is your current complete
          archetype.
        </p>
        <ol className="mt-3 space-y-3">
          {ARCHETYPE_CATALOG.map((row) => (
            <li
              key={`${row.repertoire}.${row.pace}`}
              className="rounded-lg border border-border bg-bg-surface/45 p-3"
            >
              <p className="text-micro font-semibold uppercase tracking-wider text-text-dim">
                {repertoireLabel(row.repertoire)} · {paceLabel(row.pace)}
              </p>
              <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {matchupCategories.map((category) => {
                  const key = `${row.repertoire}|${row.pace}|${category}`;
                  const current = key === currentKey;
                  return (
                    <li
                      key={category}
                      data-testid="archetype-option"
                      aria-current={current ? "true" : undefined}
                      className={[
                        "rounded-lg border px-2.5 py-2",
                        current
                          ? "border-accent bg-accent/10"
                          : "border-border bg-bg-elevated/35",
                      ].join(" ")}
                    >
                      <span className="block text-micro text-text-dim">
                        {MATCHUP_CATEGORY_LABELS[category]}
                      </span>
                      <span className="mt-0.5 block text-caption font-semibold text-text">
                        {row.names[category]}
                      </span>
                      {current ? (
                        <span className="mt-1 inline-block rounded-full bg-accent/15 px-2 py-0.5 text-micro font-semibold text-accent-cyan">
                          Your archetype
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}

function axisAvailable(
  axis: FingerprintAxis | undefined,
): axis is FingerprintAxis & { position: number; value: number } {
  return Boolean(
    axis &&
      typeof axis.position === "number" &&
      Number.isFinite(axis.position) &&
      typeof axis.value === "number" &&
      Number.isFinite(axis.value) &&
      axis.category &&
      axis.categoryLabel,
  );
}

function axisValueLabel(
  key: AxisKey,
  axis: FingerprintAxis,
  fp: FingerprintData,
): string {
  if (axis.value == null) return "—";
  if (key === "repertoire") {
    const count = Math.round(axis.value);
    return `${count} build${count === 1 ? "" : "s"}`;
  }
  if (key === "pace") return `${formatDuration(axis.value)} avg`;
  if (axis.category === "specialist") {
    return `${formatPercentGap(fp.matchupSummary.leaderGap)} stronger`;
  }
  if (axis.category === "blind_spot") {
    return `${formatPercentGap(fp.matchupSummary.weakGap)} weaker`;
  }
  return `${formatPercentGap(fp.matchupSummary.spread)} range`;
}

function missingAxisEvidence(
  key: AxisKey,
  axis: FingerprintAxis | undefined,
  fp: FingerprintData,
): string {
  if (key === "repertoire") {
    return `We need 10 recent replays with a recognized build. We have ${axis?.sampleSize ?? 0}.`;
  }
  if (key === "pace") {
    return `We need 10 recent replays with a valid game time. We have ${axis?.sampleSize ?? 0}.`;
  }
  const counts = fp.matchupWinRates
    .map((row) => `${row.matchup} ${row.decidedGames}/10`)
    .join(" · ");
  return `We need 10 wins or losses in each matchup${counts ? `. Right now: ${counts}.` : "."}`;
}

function axisEvidence(
  key: AxisKey,
  axis: FingerprintAxis,
  fp: FingerprintData,
): string {
  const sample = axis.sampleSize.toLocaleString();
  if (key === "repertoire") {
    const count = Math.round(axis.value as number);
    return `We recognized ${count} different build${count === 1 ? "" : "s"} across ${sample} recent ${fp.matchup} replay${axis.sampleSize === 1 ? "" : "s"}.`;
  }
  if (key === "pace") {
    return `Your ${sample} timed ${fp.matchup} replay${axis.sampleSize === 1 ? "" : "s"} averaged ${formatDuration(axis.value as number)}.`;
  }
  const { leaderGap, spread, strongestMatchup, weakGap, weakestMatchup } =
    fp.matchupSummary;
  if (axis.category === "specialist") {
    return `You win ${strongestMatchup ?? "your strongest matchup"} at least ${formatPercentGap(leaderGap)} more often than either of your other matchups. That makes it your Matchup Specialist side, based on ${sample} wins and losses.`;
  }
  if (axis.category === "blind_spot") {
    return `You win ${weakestMatchup ?? "your weakest matchup"} at least ${formatPercentGap(weakGap)} less often than either of your other matchups. That makes it your Matchup Blind Spot side, based on ${sample} wins and losses.`;
  }
  if (axis.category === "universalist") {
    return `Your three matchup win rates are only ${formatPercentGap(spread)} apart, putting you at Completely Balanced. This uses ${sample} wins and losses.`;
  }
  const direction =
    (axis.position as number) < 50
      ? "toward Matchup Specialist"
      : (axis.position as number) > 50
        ? "toward Matchup Blind Spot"
        : "right in the middle";
  return `Your best and worst matchup are ${formatPercentGap(spread)} apart, so your marker sits ${direction}. This uses ${sample} wins and losses.`;
}

function clampPosition(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function normalizeWinRate(value: number): number {
  return Math.abs(value) <= 1 ? value * 100 : value;
}

function formatWinRate(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${formatNumber(normalizeWinRate(value), 3)}%`;
}

function formatPercentGap(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${formatNumber(value, 3)}%`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const totalHundredths = Math.round(seconds * 100);
  const minutes = Math.floor(totalHundredths / 6000);
  const remainderHundredths = totalHundredths % 6000;
  const wholeSeconds = Math.floor(remainderHundredths / 100);
  const hundredths = remainderHundredths % 100;
  const fraction =
    hundredths === 0
      ? ""
      : hundredths % 10 === 0
        ? `.${hundredths / 10}`
        : `.${String(hundredths).padStart(2, "0")}`;
  return `${minutes}:${String(wholeSeconds).padStart(2, "0")}${fraction}`;
}

function formatNumber(value: number, places: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: places,
  });
}

function repertoireLabel(value: CatalogRow["repertoire"]): string {
  if (value === "grinder") return "Consistent Grinder";
  if (value === "creative") return "Creative Genius";
  return "Adaptive Strategist";
}

function paceLabel(value: CatalogRow["pace"]): string {
  if (value === "cheeser") return "Cheeser";
  if (value === "late_game") return "Late-Game Specialist";
  return "Flexible Pacer";
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
