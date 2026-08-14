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
  repertoireSummary?: {
    distinctBuilds: number;
    effectiveBuilds: number;
  };
  paceSummary?: {
    averageSec: number | null;
    medianSec: number | null;
    belowFive: CountShare;
    fiveToSeven: CountShare;
    aboveSeven: CountShare;
    sevenToFifteen: CountShare;
    aboveFifteen: CountShare;
  };
  matchupWinRates: MatchupWinRate[];
  matchupSummary: {
    spread: number | null;
    leaderGap: number | null;
    weakGap: number | null;
    strongestMatchup: string | null;
    weakestMatchup: string | null;
    signedEdge?: number | null;
    tierScore?: -2 | -1 | 0 | 1 | 2 | null;
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

type CountShare = {
  games: number;
  percent: number | null;
};

type AxisLegendItem = {
  label: string;
  detail: string;
};

type AxisMeta = {
  title: string;
  description: string;
  legend: ReadonlyArray<AxisLegendItem>;
  legendNote: string;
  trackTicks: ReadonlyArray<number>;
  trackClass: string;
};

type RepertoireCategory =
  | "one_trick"
  | "signature"
  | "grinder"
  | "adaptive"
  | "creative";

type PaceCategory =
  | "cheeser"
  | "timing_attacker"
  | "flexible"
  | "mid_late_master"
  | "late_game"
  | "late_game_master"
  | "two_speed";

type MatchupCategory =
  | "specialist"
  | "matchup_edge"
  | "universalist"
  | "matchup_hurdle"
  | "blind_spot";

type CatalogRow = {
  repertoire: RepertoireCategory;
  pace: PaceCategory;
  coreName: string;
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
    description:
      "How broad your build pool really is after weighting each build by how often you play it.",
    legend: [
      { label: "Build-Order One-Trick", detail: "≤1.50 effective" },
      { label: "Signature Pilot", detail: ">1.50 to 2.50" },
      { label: "Consistent Grinder", detail: ">2.50 to 5.00" },
      { label: "Adaptive Strategist", detail: ">5.00 and <10" },
      { label: "Creative Genius", detail: "10+ effective" },
    ],
    legendNote:
      "The marker is your continuous effective count; the cards below are tier rules, not evenly spaced tick labels.",
    trackTicks: [0, 11.765, 41.176, 100],
    trackClass: "from-text-dim/45 via-accent/45 to-accent-cyan/70",
  },
  pace: {
    title: "Game-time profile",
    description:
      "Combines your average with where your games cluster, so split-speed and mastery patterns stay visible.",
    legend: [
      { label: "Cheeser", detail: "average <5:00" },
      { label: "Timing Attacker", detail: "≥80% from 5–7" },
      { label: "Flexible Pacer", detail: "5–15 average" },
      { label: "Mid/Late-Game Master", detail: "≥80% >7" },
      { label: "Long-Game Lean", detail: "average >15:00" },
      { label: "Late-Game Master", detail: "≥80% >15" },
      { label: "Two-Speed Player", detail: "≥25% <5 and >15" },
    ],
    legendNote:
      "The marker shows your average from the 5:00 to 15:00 scale. The badge can use the distribution rules below and override the average fallback.",
    trackTicks: [0, 20, 100],
    trackClass: "from-warning/60 via-accent/40 to-accent-cyan/70",
  },
  matchup_balance: {
    title: "Matchup strengths",
    description:
      "Compares all three win rates. Strength pulls left, balance stays centered, and a weak matchup pulls right.",
    legend: [
      { label: "Matchup Master", detail: "≥+10 points" },
      { label: "Matchup Edge", detail: "+7.5 anchor" },
      { label: "All-Matchup Ace", detail: "all within 5" },
      { label: "Matchup Hurdle", detail: "−7.5 anchor" },
      { label: "Matchup Blind Spot", detail: "≤−10 points" },
    ],
    legendNote:
      "These five states align to the track: 7.5 points anchors the inner edge/hurdle marks and 10 points reaches an endpoint.",
    trackTicks: [0, 25, 50, 75, 100],
    trackClass: "from-accent-cyan/70 via-accent/30 to-danger/65",
  },
};

const MATCHUP_CATEGORY_LABELS: Record<MatchupCategory, string> = {
  specialist: "Matchup Master",
  matchup_edge: "Matchup Edge",
  universalist: "All-Matchup Ace",
  matchup_hurdle: "Matchup Hurdle",
  blind_spot: "Matchup Blind Spot",
};

const ARCHETYPE_CATALOG: ReadonlyArray<CatalogRow> = [
  { repertoire: "one_trick", pace: "cheeser", coreName: "Pocket-Knife Ambusher" },
  { repertoire: "one_trick", pace: "timing_attacker", coreName: "Clockwork Attacker" },
  { repertoire: "one_trick", pace: "flexible", coreName: "Signature-Plan Pilot" },
  { repertoire: "one_trick", pace: "mid_late_master", coreName: "One-Line Commander" },
  { repertoire: "one_trick", pace: "late_game", coreName: "Fortress Devotee" },
  { repertoire: "one_trick", pace: "late_game_master", coreName: "Endgame Purist" },
  { repertoire: "one_trick", pace: "two_speed", coreName: "Binary Switchblade" },
  { repertoire: "signature", pace: "cheeser", coreName: "Opening Loyalist" },
  { repertoire: "signature", pace: "timing_attacker", coreName: "Timing Craftsman" },
  { repertoire: "signature", pace: "flexible", coreName: "Comfort-Pool Captain" },
  { repertoire: "signature", pace: "mid_late_master", coreName: "Core-Plan Commander" },
  { repertoire: "signature", pace: "late_game", coreName: "Scaling Loyalist" },
  { repertoire: "signature", pace: "late_game_master", coreName: "Endgame Artisan" },
  { repertoire: "signature", pace: "two_speed", coreName: "Dual-Gear Duelist" },
  { repertoire: "grinder", pace: "cheeser", coreName: "Repetition Raider" },
  { repertoire: "grinder", pace: "timing_attacker", coreName: "Timing Technician" },
  { repertoire: "grinder", pace: "flexible", coreName: "Disciplined Operator" },
  { repertoire: "grinder", pace: "mid_late_master", coreName: "Macro Mechanic" },
  { repertoire: "grinder", pace: "late_game", coreName: "Endurance Engineer" },
  { repertoire: "grinder", pace: "late_game_master", coreName: "Siege Architect" },
  { repertoire: "grinder", pace: "two_speed", coreName: "Tempo Gearbox" },
  { repertoire: "adaptive", pace: "cheeser", coreName: "Counter-Build Hunter" },
  { repertoire: "adaptive", pace: "timing_attacker", coreName: "Timing Shapeshifter" },
  { repertoire: "adaptive", pace: "flexible", coreName: "Adaptive Competitor" },
  { repertoire: "adaptive", pace: "mid_late_master", coreName: "Strategic Navigator" },
  { repertoire: "adaptive", pace: "late_game", coreName: "Scaling Strategist" },
  { repertoire: "adaptive", pace: "late_game_master", coreName: "Endgame Generalist" },
  { repertoire: "adaptive", pace: "two_speed", coreName: "Two-Gear Tactician" },
  { repertoire: "creative", pace: "cheeser", coreName: "Lab-Crafted Ambusher" },
  { repertoire: "creative", pace: "timing_attacker", coreName: "Timing Inventor" },
  { repertoire: "creative", pace: "flexible", coreName: "Build-Lab Explorer" },
  { repertoire: "creative", pace: "mid_late_master", coreName: "Transition Alchemist" },
  { repertoire: "creative", pace: "late_game", coreName: "Late-Game Visionary" },
  { repertoire: "creative", pace: "late_game_master", coreName: "Strategic Polymath" },
  { repertoire: "creative", pace: "two_speed", coreName: "Chaos Switchboard" },
];

const MATCHUP_ARCHETYPE_PREFIX: Record<MatchupCategory, string> = {
  specialist: "Apex",
  matchup_edge: "Favored",
  universalist: "Universal",
  matchup_hurdle: "Battle-Tested",
  blind_spot: "Fault-Line",
};

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

          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2">
            <HeroStat label="Matchup" value={fp.matchup} />
            <HeroStat
              label="Detected builds"
              value={
                axisAvailable(repertoire)
                  ? (fp.repertoireSummary?.distinctBuilds ?? fp.buildOrders.length).toLocaleString()
                  : "Still forming"
              }
            />
            <HeroStat
              label="Effective pool"
              value={
                axisAvailable(repertoire)
                  ? formatEffectiveBuilds(
                      fp.repertoireSummary?.effectiveBuilds ?? repertoire.value,
                    )
                  : "Still forming"
              }
            />
            <HeroStat
              label="Avg game"
              value={axisAvailable(pace) ? formatDuration(pace.value) : "Still forming"}
            />
            <HeroStat
              label="Time profile"
              value={
                axisAvailable(pace)
                  ? pace.categoryLabel ?? "Still forming"
                  : "Still forming"
              }
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

      <div
        className={`grid gap-4 ${
          fp.paceSummary ? "xl:grid-cols-3" : "lg:grid-cols-2"
        }`}
      >
        <MatchupEvidence fp={fp} />
        <PaceEvidence fp={fp} />
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
  const legendGrid =
    axisKey === "pace"
      ? "grid-cols-2 sm:grid-cols-4 xl:grid-cols-7"
      : "grid-cols-2 sm:grid-cols-5";

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
              {meta.trackTicks.map((position) => (
                <span
                  key={position}
                  className="absolute top-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-text/30"
                  style={{ left: `${position}%` }}
                />
              ))}
              <span
                data-testid={`fingerprint-marker-${axisKey}`}
                className="absolute top-1/2 h-5 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg bg-text shadow-hard"
                style={{ left: `${clampPosition(axis.position)}%` }}
              />
            </div>
            <p className="mt-2 text-center text-micro leading-relaxed text-text-dim">
              {meta.legendNote}
            </p>
            <ul className={`mt-3 grid gap-1.5 ${legendGrid}`}>
              {meta.legend.map((item) => (
                <li
                  key={item.label}
                  className="rounded-md border border-border/75 bg-bg-surface/45 px-2 py-1.5 text-center"
                >
                  <span className="block text-micro font-semibold leading-tight text-text-muted">
                    {item.label}
                  </span>
                  <span className="mt-0.5 block text-micro leading-tight tabular-nums text-text-dim">
                    {item.detail}
                  </span>
                </li>
              ))}
            </ul>
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
          <div className="text-right text-micro font-semibold tabular-nums text-text-muted">
            {fp.matchupSummary.signedEdge != null &&
            matchupCategory !== "universalist" ? (
              <span className="block">
                {formatSignedPoints(fp.matchupSummary.signedEdge)} dominant gap
              </span>
            ) : null}
            {fp.matchupSummary.tierScore != null ? (
              <span className="block">
                Tier score {fp.matchupSummary.tierScore > 0 ? "+" : ""}
                {fp.matchupSummary.tierScore}
              </span>
            ) : null}
            <span className="block">
              {formatPointGap(fp.matchupSummary.spread)} best-to-worst
            </span>
          </div>
        ) : null}
      </div>

      {fp.matchupWinRates.length > 0 ? (
        <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {fp.matchupWinRates.map((row) => {
            const strongest =
              (matchupCategory === "specialist" ||
                matchupCategory === "matchup_edge") &&
              row.matchup === fp.matchupSummary.strongestMatchup;
            const weakest =
              (matchupCategory === "blind_spot" ||
                matchupCategory === "matchup_hurdle") &&
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
                {strongest || weakest ? (
                  <dd
                    className={`mt-2 text-micro font-semibold ${
                      strongest ? "text-accent-cyan" : "text-danger"
                    }`}
                  >
                    {strongest ? "Strongest matchup" : "Toughest matchup"}
                  </dd>
                ) : null}
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

function PaceEvidence({ fp }: { fp: FingerprintData }) {
  const pace = fp.axes.find((axis) => axis.key === "pace");
  const summary = fp.paceSummary;
  if (!summary || !pace) return null;
  const available = axisAvailable(pace);

  const bins = [
    { label: "Under 5:00", value: summary.belowFive },
    { label: "5:00–7:00", value: summary.fiveToSeven },
    { label: "Over 7:00–15:00", value: summary.sevenToFifteen },
    { label: "Over 15:00", value: summary.aboveFifteen },
  ];

  return (
    <section
      className="rounded-xl border border-border bg-bg-elevated/25 p-4"
      aria-labelledby="pace-evidence-heading"
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h4 id="pace-evidence-heading" className="text-caption font-semibold text-text">
            Game-time distribution
          </h4>
          <p className="mt-0.5 text-micro text-text-dim">
            Real timed replays behind your pace profile.
          </p>
        </div>
        {summary.medianSec != null ? (
          <span className="text-micro font-semibold tabular-nums text-text-muted">
            {formatDuration(summary.medianSec)} median
          </span>
        ) : null}
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2">
        {bins.map((bin) => (
          <div
            key={bin.label}
            className="rounded-lg border border-border bg-bg-surface/55 p-2.5"
          >
            <dt className="text-micro font-medium text-text-dim">{bin.label}</dt>
            <dd className="mt-1 font-display text-caption font-bold tabular-nums text-text">
              {formatSharePercent(bin.value.percent)}
            </dd>
            <dd className="mt-0.5 text-micro tabular-nums text-text-muted">
              {bin.value.games} game{bin.value.games === 1 ? "" : "s"}
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-3 border-t border-border pt-3 text-caption leading-relaxed text-text-muted">
        {available
          ? paceProfileEvidence(pace, summary)
          : `${pace.sampleSize.toLocaleString()} valid timed replay${pace.sampleSize === 1 ? " is" : "s are"} available. The distribution is real, but the pace label stays unranked until 10 are available.`}
      </p>
    </section>
  );
}

function BuildEvidence({ fp }: { fp: FingerprintData }) {
  const preview = fp.buildOrders.slice(0, 8);
  const remaining = fp.buildOrders.length - preview.length;
  const distinctBuilds =
    fp.repertoireSummary?.distinctBuilds ?? fp.buildOrders.length;
  const effectiveBuilds = fp.repertoireSummary?.effectiveBuilds;
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
        <div className="text-right text-micro font-semibold tabular-nums text-text-muted">
          <span className="block">{distinctBuilds} distinct</span>
          {effectiveBuilds != null ? (
            <span className="block text-accent-cyan">
              {formatEffectiveBuilds(effectiveBuilds)} effective
            </span>
          ) : null}
        </div>
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
      {effectiveBuilds != null && fp.buildOrders.length > 0 ? (
        <p className="mt-3 border-t border-border pt-3 text-micro leading-relaxed text-text-muted">
          {distinctBuilds} detected names become {formatEffectiveBuilds(effectiveBuilds)} effective
          builds after weighting each one by its share of your classified games.
        </p>
      ) : null}
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
          Build variety and the game-time profile use your latest {fp.games}{" "}
          {fp.matchup} 1v1 replays, up to {fp.windowGames}. The matchup-strength
          track compares separate recent windows against Protoss, Terran, and Zerg.
          Each track needs enough games before it receives a rating. Dashboard
          filters do not change these replay windows.
        </p>

        <ol className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <li className="rounded-lg border border-border bg-bg-surface/55 p-3">
            <p className="text-caption font-semibold text-text">1. Build variety</p>
            <div className="mt-1 space-y-2 text-micro leading-relaxed text-text-muted">
              <p>
                <strong className="text-text">Distinct builds</strong> count every
                recognized build name once. <strong className="text-text">Effective
                builds</strong> also uses frequency: for each build, we take its share
                of classified games (<em>p</em>), square those shares, add them, then
                calculate <strong className="font-mono text-text">1 ÷ Σp²</strong>.
              </p>
              <p>
                If every build is used equally, effective and distinct are the
                same. Repeated favorites pull the effective count toward 1;
                one-off builds add breadth but little weight. An effective count
                is an equally-used-build equivalent—not a fraction of a build.
              </p>
              {fp.repertoireSummary && fp.repertoireSummary.distinctBuilds > 0 ? (
                <p className="rounded-md border border-accent/20 bg-accent/5 p-2 text-text-muted">
                  Your current window has {fp.repertoireSummary.distinctBuilds} detected
                  builds and {formatEffectiveBuilds(fp.repertoireSummary.effectiveBuilds)} effective.
                  That means your real usage mix is as diverse as{" "}
                  {formatEffectiveBuilds(fp.repertoireSummary.effectiveBuilds)} builds
                  played equally often.
                </p>
              ) : fp.repertoireSummary ? (
                <p className="rounded-md border border-border bg-bg-elevated/40 p-2 text-text-dim">
                  No named build has been classified in this window yet, so
                  effective diversity cannot be interpreted.
                </p>
              ) : null}
              <p>
                The unrounded effective count selects the tier: 1.50 or less is
                Build-Order One-Trick; over 1.50 through 2.50 is Signature Pilot;
                over 2.50 through 5.00 is Consistent Grinder; over 5.00 but under
                10 is Adaptive Strategist; 10 or more is Creative Genius. At
                least 10 distinct builds are therefore necessary—but not enough
                if most appeared only once. Unclassified replays are excluded.
              </p>
            </div>
          </li>
          <li className="rounded-lg border border-border bg-bg-surface/55 p-3">
            <p className="text-caption font-semibold text-text">2. Game-time profile</p>
            <div className="mt-1 space-y-2 text-micro leading-relaxed text-text-muted">
              <p>
                We use the average and the full distribution. Distinctive patterns
                win first: Two-Speed needs at least 25% of games under 5:00 and
                25% over 15:00; Late-Game Master needs at least 80% over 15:00;
                Mid/Late-Game Master needs at least 80% over 7:00; Timing Attacker
                needs at least 80% from 5:00 through 7:00.
              </p>
              <p>
                If none applies, an average strictly under 5:00 is Cheeser, an
                average from 5:00 through 15:00 is Flexible Pacer, and an average
                over 15:00 is Long-Game Lean. Specific distribution profiles can
                override the average fallback; this is how a genuine short/long
                Two-Speed split avoids being mislabeled Flexible.
              </p>
              <p>
                Exact 5:00 and 15:00 games are not Two-Speed extremes; exact 7:00
                belongs to the timing window. Wins and losses both count. Games
                under 45 seconds are ignored as likely quits or restarts.
              </p>
            </div>
          </li>
          <li className="rounded-lg border border-border bg-bg-surface/55 p-3">
            <p className="text-caption font-semibold text-text">3. Matchup strengths</p>
            <div className="mt-1 space-y-2 text-micro leading-relaxed text-text-muted">
              <p>
                We rank your three win rates, then compare best to middle and
                middle to worst. All three within 5 percentage points is an
                All-Matchup Ace (score 0). Otherwise the larger adjacent gap sets
                the direction: strength is positive and a hurdle is negative.
              </p>
              <p>
                A dominant +10-point gap is Matchup Master (score +2); a smaller
                positive gap is Matchup Edge (+1). A dominant −10-point gap is
                Matchup Blind Spot (−2); a smaller negative gap is Matchup Hurdle
                (−1). The ±7.5 marks are scoring anchors for a clear edge or
                hurdle, not a sixth category—gaps just above 5 still need a home.
              </p>
              <p>
                If the strength and hurdle gaps are exactly equal, strength wins
                the deterministic tie-break. Each matchup needs 10 decided games
                from its own latest-50 window. Replay ties are displayed, but only
                wins and losses enter the win rates.
              </p>
            </div>
          </li>
        </ol>

        <p className="mt-4 rounded-lg border border-accent/25 bg-accent/5 p-3 text-micro leading-relaxed text-text-muted">
          Your archetype combines one of five build-pool tiers, seven game-time
          profiles, and five matchup shapes: 175 deterministic possibilities,
          all calculated from your real replays. If one track needs more games,
          your profile stays incomplete until the replay evidence is there.
        </p>
      </div>
    </details>
  );
}

function ArchetypeCatalog({ currentKey }: { currentKey: string }) {
  const matchupCategories: ReadonlyArray<MatchupCategory> = [
    "specialist",
    "matchup_edge",
    "universalist",
    "matchup_hurdle",
    "blind_spot",
  ];

  return (
    <details
      data-testid="fingerprint-archetype-catalog"
      className="group rounded-xl border border-border bg-bg-elevated/25"
    >
      <summary className="flex min-h-[48px] cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 text-caption font-semibold text-text transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <Fingerprint className="h-4 w-4 flex-none text-accent-cyan" aria-hidden />
        <span>All 175 archetypes</span>
        <ChevronDown
          className="ml-auto h-4 w-4 flex-none text-text-dim transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>

      <div className="border-t border-border px-3 py-4 sm:px-4">
        <p className="text-micro leading-relaxed text-text-dim">
          Thirty-five build-pool and game-time combinations, each with five
          matchup shapes. Names are compositional, so the title stays readable:
          matchup prefix plus the build-and-time core. The highlighted entry is
          your current complete archetype.
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
              <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">
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
                        {catalogArchetypeName(row, category)}
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
    return `${formatEffectiveBuilds(axis.value)} effective`;
  }
  if (key === "pace") return `${formatDuration(axis.value)} avg`;
  if (axis.category === "specialist") {
    return `+${formatPointGap(fp.matchupSummary.leaderGap)} master edge`;
  }
  if (axis.category === "matchup_edge") {
    return `+${formatPointGap(fp.matchupSummary.leaderGap)} edge`;
  }
  if (axis.category === "matchup_hurdle") {
    return `−${formatPointGap(fp.matchupSummary.weakGap)} hurdle`;
  }
  if (axis.category === "blind_spot") {
    return `−${formatPointGap(fp.matchupSummary.weakGap)} blind spot`;
  }
  return `${formatPointGap(fp.matchupSummary.spread)} total range`;
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
    const distinct =
      fp.repertoireSummary?.distinctBuilds ?? fp.buildOrders.length;
    const effective =
      fp.repertoireSummary?.effectiveBuilds ?? (axis.value as number);
    return `We detected ${distinct} distinct build${distinct === 1 ? "" : "s"} across ${sample} classified ${fp.matchup} replay${axis.sampleSize === 1 ? "" : "s"}. Their play-frequency mix equals ${formatEffectiveBuilds(effective)} equally used builds, which selects ${axis.categoryLabel}.`;
  }
  if (key === "pace") {
    const base = `Your ${sample} timed ${fp.matchup} replay${axis.sampleSize === 1 ? "" : "s"} averaged ${formatDuration(axis.value as number)}.`;
    return fp.paceSummary
      ? `${base} The ${axis.categoryLabel} badge uses the real time-band counts in the distribution card below.`
      : base;
  }
  const { leaderGap, spread, strongestMatchup, weakGap, weakestMatchup } =
    fp.matchupSummary;
  if (axis.category === "specialist") {
    return `${strongestMatchup ?? "Your strongest matchup"} leads your middle matchup by ${formatPointGap(leaderGap)}. That clears the 10-point Matchup Master line, based on ${sample} wins and losses.`;
  }
  if (axis.category === "matchup_edge") {
    const strength = (leaderGap ?? 0) >= 7.5 ? "clear" : "developing";
    return `${strongestMatchup ?? "Your strongest matchup"} leads your middle matchup by ${formatPointGap(leaderGap)}, a ${strength} Matchup Edge. The 7.5-point mark is the track anchor; this profile covers every positive, sub-10 gap outside the five-point balanced zone. This uses ${sample} wins and losses.`;
  }
  if (axis.category === "blind_spot") {
    return `${weakestMatchup ?? "Your toughest matchup"} trails your middle matchup by ${formatPointGap(weakGap)}. That clears the 10-point Matchup Blind Spot line, based on ${sample} wins and losses.`;
  }
  if (axis.category === "matchup_hurdle") {
    const strength = (weakGap ?? 0) >= 7.5 ? "clear" : "developing";
    return `${weakestMatchup ?? "Your toughest matchup"} trails your middle matchup by ${formatPointGap(weakGap)}, a ${strength} Matchup Hurdle. The 7.5-point mark is the track anchor; this profile covers every negative, sub-10 gap outside the five-point balanced zone. This uses ${sample} wins and losses.`;
  }
  if (axis.category === "universalist") {
    return `Your best and worst matchup win rates are ${formatPointGap(spread)} apart, so all three fit inside the five-point All-Matchup Ace band. This uses ${sample} wins and losses.`;
  }
  return `Your best and worst matchup are ${formatPointGap(spread)} apart. This uses ${sample} wins and losses.`;
}

function paceProfileEvidence(
  axis: FingerprintAxis,
  summary: NonNullable<FingerprintData["paceSummary"]>,
): string {
  const sample = axis.sampleSize;
  if (axis.category === "two_speed") {
    return `${summary.belowFive.games}/${sample} (${formatSharePercent(summary.belowFive.percent)}) ended under 5:00 and ${summary.aboveFifteen.games}/${sample} (${formatSharePercent(summary.aboveFifteen.percent)}) ran over 15:00, meeting both Two-Speed quarters.`;
  }
  if (axis.category === "late_game_master") {
    return `${summary.aboveFifteen.games}/${sample} (${formatSharePercent(summary.aboveFifteen.percent)}) ran over 15:00, meeting the 80% Late-Game Master rule.`;
  }
  if (axis.category === "mid_late_master") {
    return `${summary.aboveSeven.games}/${sample} (${formatSharePercent(summary.aboveSeven.percent)}) reached beyond 7:00, meeting the 80% Mid/Late-Game Master rule.`;
  }
  if (axis.category === "timing_attacker") {
    return `${summary.fiveToSeven.games}/${sample} (${formatSharePercent(summary.fiveToSeven.percent)}) finished from 5:00 through 7:00, meeting the 80% Timing Attacker rule.`;
  }
  if (axis.category === "cheeser") {
    return "The average is strictly under 5:00, so the fallback profile is Cheeser.";
  }
  if (axis.category === "late_game") {
    return "The average is over 15:00 without an 80% long-game cluster, so the honest fallback is Long-Game Lean.";
  }
  return "The average is from 5:00 through 15:00 and no stronger distribution pattern overrides it, so the fallback is Flexible Pacer.";
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

function formatSharePercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${formatNumber(value, 1)}%`;
}

function formatPointGap(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${formatNumber(value, 3)} percentage point${Math.abs(value) === 1 ? "" : "s"}`;
}

function formatSignedPoints(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatNumber(Math.abs(value), 3)} pts`;
}

function formatEffectiveBuilds(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  const nearBoundary = [1.5, 2.5, 5, 10].some(
    (boundary) => Math.abs(value - boundary) > 0 && Math.abs(value - boundary) < 0.01,
  );
  return formatNumber(value, nearBoundary ? 6 : 2);
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

function repertoireLabel(value: RepertoireCategory): string {
  const labels: Record<RepertoireCategory, string> = {
    one_trick: "Build-Order One-Trick",
    signature: "Signature Pilot",
    grinder: "Consistent Grinder",
    adaptive: "Adaptive Strategist",
    creative: "Creative Genius",
  };
  return labels[value];
}

function paceLabel(value: PaceCategory): string {
  const labels: Record<PaceCategory, string> = {
    cheeser: "Cheeser",
    timing_attacker: "Timing Attacker",
    flexible: "Flexible Pacer",
    mid_late_master: "Mid/Late-Game Master",
    late_game: "Long-Game Lean",
    late_game_master: "Late-Game Master",
    two_speed: "Two-Speed Player",
  };
  return labels[value];
}

function catalogArchetypeName(
  row: CatalogRow,
  matchup: MatchupCategory,
): string {
  return `${MATCHUP_ARCHETYPE_PREFIX[matchup]} ${row.coreName}`;
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
