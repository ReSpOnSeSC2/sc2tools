"use client";

import Link from "next/link";
import { useId, useState } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  CircleHelp,
  Fingerprint,
  RefreshCw,
  ShieldQuestion,
} from "lucide-react";

import { Badge, Button, Card, EmptyStatePanel, Icon } from "@/components/ui";
import { useApi } from "@/lib/clientApi";
import { useFilters } from "@/lib/filterContext";
import { coerceRace, raceIconName, raceTint } from "@/lib/race";
import { CandidateEvidenceDetails } from "./OpponentIdentityCandidateEvidence";

type IdentityMatchStatus =
  | "ready"
  | "not_eligible"
  | "insufficient_data"
  | "no_candidates";

type EvidenceMode =
  | "build_and_control_groups"
  | "control_groups_only"
  | "build_only"
  | "none";

type EvidenceConfidence = "high" | "medium" | "low";

export type IdentityMatchEligibility = {
  eligible: boolean;
  isBarcode: boolean;
  pulseResolved: boolean;
  mmrPresent: boolean;
  reasons: string[];
};

export type IdentityMatchTarget = {
  pulseId?: string | null;
  name?: string | null;
  race: string | null;
  raceCode: string | null;
  games: number;
  buildGames?: number;
  controlGroupGames?: number;
  evidenceMode?: EvidenceMode;
  matchup?: string | null;
};

export type BuildOrderMatchEvidence = {
  score: number;
  targetSamples: number;
  candidateSamples: number;
  sharedBuilds: string[];
  sharedMilestones: Array<{ name: string; deltaSec: number }>;
  highlights: string[];
};

export type ControlGroupMatchEvidence = {
  score: number;
  targetSamples: number;
  candidateSamples: number;
  matchedSlots: number[];
  highlights: string[];
};

export type IdentityCandidate = {
  rank: number;
  pulseId: string;
  pulseCharacterId: string | null;
  name: string;
  race: string | null;
  region: string | null;
  mmr: number | null;
  gamesInProfile: number;
  /** Open-set, uncalibrated estimate. It is not the raw match score. */
  likelihood: number;
  /** Raw behavioral closeness across the evidence components available. */
  patternMatch: number;
  confidence: EvidenceConfidence;
  evidenceQuality: number;
  sample: {
    targetGames: number;
    candidateGames: number;
    targetEvidenceGames: number;
    candidateEvidenceGames: number;
  };
  evidence: {
    coverage: number;
    buildOrders?: BuildOrderMatchEvidence | null;
    controlGroups?: ControlGroupMatchEvidence | null;
  };
  caveats: string[];
};

export type OpponentIdentityCandidatesResponse = {
  status: IdentityMatchStatus;
  calibrated: false;
  methodologyVersion: string;
  generatedAt?: string;
  eligibility: IdentityMatchEligibility;
  target: IdentityMatchTarget;
  candidates: IdentityCandidate[];
  /** Probability mass reserved for a player absent from the known candidate set. */
  unknownLikelihood: number;
  /** Probability mass for known candidates ranked below the five returned rows. */
  otherLikelihood: number;
  scope: {
    source: string;
    searchedOpponents: number;
    searchedGames: number;
    truncated: boolean;
  };
  insufficiency?: { code: string; message: string };
};

export interface OpponentIdentityCandidatesProps {
  pulseId: string;
  enabled: boolean;
  race?: string | null;
}

/**
 * Private, probabilistic identity leads for an unresolved barcode opponent.
 *
 * The matcher is intentionally a separate request: ordinary opponent profiles
 * never pay for its bounded database scan. The server limits the search to the
 * signed-in user's own same-race replay history.
 */
export function OpponentIdentityCandidates({
  pulseId,
  enabled,
  race,
}: OpponentIdentityCandidatesProps) {
  const { dbRev } = useFilters();
  const path = enabled
    ? `/v1/opponents/${encodeURIComponent(pulseId)}/identity-candidates#${dbRev}`
    : null;
  const { data, error, isLoading, isValidating, mutate } =
    useApi<OpponentIdentityCandidatesResponse>(path, {
      revalidateOnFocus: false,
    });

  if (!enabled || data?.status === "not_eligible") return null;

  const displayRace = data?.target.race || race || null;
  const refreshing = Boolean(data && isValidating);

  return (
    <Card
      padded={false}
      aria-labelledby="identity-candidates-title"
      data-testid="opponent-identity-candidates"
    >
      <IdentityPanelHeader race={displayRace} refreshing={refreshing} />
      <Card.Body>
        {isLoading && !data ? (
          <CandidatesSkeleton />
        ) : error && !data ? (
          <LoadError
            message={error.message}
            onRetry={() => void mutate()}
          />
        ) : data?.status === "insufficient_data" ? (
          <UnavailableState response={data} kind="insufficient" />
        ) : data?.status === "no_candidates" ? (
          <UnavailableState response={data} kind="empty" />
        ) : data?.status === "ready" && data.candidates.length > 0 ? (
          <ReadyCandidates response={data} />
        ) : data?.status === "ready" ? (
          <UnavailableState response={data} kind="empty" />
        ) : error ? (
          <LoadError
            message={error.message}
            onRetry={() => void mutate()}
          />
        ) : (
          <CandidatesSkeleton />
        )}
      </Card.Body>
    </Card>
  );
}

function IdentityPanelHeader({
  race,
  refreshing,
}: {
  race: string | null;
  refreshing: boolean;
}) {
  const resolvedRace = race ? coerceRace(race) : null;
  const tint = resolvedRace ? raceTint(resolvedRace) : null;
  return (
    <Card.Header className="flex-col items-stretch gap-3 sm:flex-row sm:items-start">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-lg border border-accent-cyan/35 bg-accent-cyan/10 text-accent-cyan">
          <Fingerprint className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2
              id="identity-candidates-title"
              className="text-body font-semibold text-text"
            >
              Possible identity matches
            </h2>
            <Badge variant="signal" size="sm">
              Experimental
            </Badge>
            <Badge variant="warning" size="sm">
              Unverified
            </Badge>
          </div>
          <p className="mt-1 text-caption leading-relaxed text-text-muted">
            Behavioral leads for an unresolved barcode, never a verified
            player identity.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        {resolvedRace && tint ? (
          <span
            className={`inline-flex min-h-6 items-center gap-1.5 rounded-full border px-2 py-0.5 text-micro font-semibold ${tint.border} ${tint.bg} ${tint.text}`}
          >
            <Icon
              name={raceIconName(resolvedRace)}
              kind="race"
              className="h-3.5 w-3.5"
            />
            {resolvedRace} only
          </span>
        ) : null}
        {refreshing ? (
          <span
            className="inline-flex items-center gap-1.5 text-micro text-text-dim"
            role="status"
            aria-live="polite"
          >
            <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden />
            Refreshing evidence…
          </span>
        ) : null}
      </div>
    </Card.Header>
  );
}

function CandidatesSkeleton() {
  return (
    <div
      className="space-y-3"
      aria-busy="true"
      aria-label="Loading possible identity matches"
    >
      <div className="h-20 animate-pulse rounded-xl border border-border bg-bg-elevated/50" />
      {Array.from({ length: 3 }).map((_, index) => (
        <div
          key={index}
          className="grid animate-pulse gap-3 rounded-xl border border-border p-4 sm:grid-cols-3"
        >
          <div className="h-5 rounded bg-bg-elevated sm:col-span-1" />
          <div className="h-5 rounded bg-bg-elevated" />
          <div className="h-5 rounded bg-bg-elevated" />
        </div>
      ))}
    </div>
  );
}

function LoadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-4 rounded-xl border border-danger/40 bg-danger/10 p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <p className="font-semibold text-text">
          Couldn&apos;t compare identity patterns
        </p>
        <p className="mt-1 text-caption text-text-muted">
          {message || "Try again in a moment."}
        </p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={onRetry}
        iconLeft={<RefreshCw className="h-4 w-4" aria-hidden />}
      >
        Try again
      </Button>
    </div>
  );
}

function UnavailableState({
  response,
  kind,
}: {
  response: OpponentIdentityCandidatesResponse;
  kind: "insufficient" | "empty";
}) {
  const title =
    kind === "insufficient"
      ? "More replay evidence is needed"
      : "No credible same-race candidates yet";
  const fallback =
    kind === "insufficient"
      ? "No build-order or control-group pattern can be compared yet."
      : "No opponent in your replay history has enough comparable evidence yet.";

  return (
    <div className="space-y-4">
      <TargetEvidenceSummary response={response} />
      <EmptyStatePanel
        size="sm"
        icon={
          kind === "insufficient" ? (
            <ShieldQuestion className="h-5 w-5" aria-hidden />
          ) : (
            <Fingerprint className="h-5 w-5" aria-hidden />
          )
        }
        title={title}
        description={response.insufficiency?.message || fallback}
      />
      <UnverifiedNotice response={response} />
    </div>
  );
}

function ReadyCandidates({
  response,
}: {
  response: OpponentIdentityCandidatesResponse;
}) {
  const candidates = response.candidates.slice(0, 5);
  return (
    <div className="space-y-4">
      <TargetEvidenceSummary response={response} />

      <ol className="space-y-3" aria-label="Ranked possible identity matches">
        {candidates.map((candidate, index) => (
          <li key={candidate.pulseId}>
            <CandidateCard candidate={candidate} featured={index === 0} />
          </li>
        ))}
      </ol>

      <UnknownCandidate
        unknownLikelihood={response.unknownLikelihood}
        otherLikelihood={response.otherLikelihood}
      />
      <UnverifiedNotice response={response} />
      <MethodologyDetails response={response} />
    </div>
  );
}

function TargetEvidenceSummary({
  response,
}: {
  response: OpponentIdentityCandidatesResponse;
}) {
  const { target, scope } = response;
  const mode = evidenceModeLabel(target.evidenceMode);
  return (
    <section
      className="rounded-xl border border-accent/25 bg-gradient-to-br from-accent/10 via-bg-surface to-bg-elevated/50 p-4"
      aria-label="Identity comparison scope"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <p className="text-caption font-semibold text-text">
            Compared against your own replay history
          </p>
          <p className="mt-1 text-micro leading-relaxed text-text-muted">
            {mode}. Candidates are restricted to {target.race || "the same race"}
            {target.matchup
              ? `; build-order evidence is matched within ${target.matchup}`
              : ""}. Dashboard date and map filters do not change identity
            evidence.
          </p>
        </div>
        <dl className="grid flex-none grid-cols-3 gap-2 text-center">
          <MiniStat label="Target games" value={target.games} />
          <MiniStat label="Profiles" value={scope.searchedOpponents} />
          <MiniStat label="Games scanned" value={scope.searchedGames} />
        </dl>
      </div>
      {scope.truncated ? (
        <p className="mt-3 border-t border-border pt-3 text-micro text-warning">
          The safety scan limit was reached. Results cover the newest bounded
          evidence, not every historical replay.
        </p>
      ) : null}
    </section>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-[4.5rem] rounded-lg border border-border bg-bg-surface/70 px-2 py-2">
      <dt className="text-[0.625rem] uppercase tracking-wider text-text-dim">
        {label}
      </dt>
      <dd className="mt-0.5 font-display text-caption font-bold tabular-nums text-text">
        {finiteCount(value).toLocaleString()}
      </dd>
    </div>
  );
}

function CandidateCard({
  candidate,
  featured,
}: {
  candidate: IdentityCandidate;
  featured: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const baseId = useId();
  const detailId = `${baseId}-evidence`;
  const candidateRace = candidate.race ? coerceRace(candidate.race) : null;
  const tint = candidateRace ? raceTint(candidateRace) : null;
  const displayRank = Number.isFinite(candidate.rank)
    ? Math.max(1, Math.round(candidate.rank))
    : 1;
  const href = `/app/opponents/${encodeURIComponent(candidate.pulseId)}`;

  return (
    <article
      data-testid="identity-candidate-row"
      className={[
        "relative min-w-0 overflow-hidden rounded-xl border p-4",
        featured
          ? "border-accent/55 bg-gradient-to-br from-accent/10 via-bg-surface to-bg-elevated/40"
          : "border-border bg-bg-surface",
      ].join(" ")}
    >
      {featured ? (
        <span
          className="absolute inset-y-0 left-0 w-1 bg-accent-cyan"
          aria-hidden
        />
      ) : null}

      <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(6.5rem,auto)_minmax(7rem,auto)] md:items-center xl:grid-cols-[minmax(0,1.1fr)_7.5rem_8rem_minmax(13rem,0.9fr)_auto]">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={[
              "flex h-8 w-8 flex-none items-center justify-center rounded-full border font-display text-caption font-bold tabular-nums",
              featured
                ? "border-accent-cyan/50 bg-accent-cyan/15 text-accent-cyan"
                : "border-border bg-bg-elevated text-text-muted",
            ].join(" ")}
            aria-label={`Rank ${displayRank}`}
          >
            {displayRank}
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3
                className="max-w-full truncate font-display text-body font-bold text-text"
                title={candidate.name}
              >
                {candidate.name || "Unnamed opponent"}
              </h3>
              <EvidenceBadge confidence={candidate.confidence} />
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-text-muted">
              {candidateRace && tint ? (
                <span className={`inline-flex items-center gap-1 ${tint.text}`}>
                  <Icon
                    name={raceIconName(candidateRace)}
                    kind="race"
                    className="h-3.5 w-3.5"
                  />
                  {candidateRace}
                </span>
              ) : null}
              {candidate.region ? <span>{candidate.region}</span> : null}
              {validPositive(candidate.mmr) ? (
                <span className="tabular-nums">
                  {Math.round(candidate.mmr as number).toLocaleString()} MMR
                </span>
              ) : null}
              <span className="tabular-nums">
                {finiteCount(candidate.gamesInProfile).toLocaleString()} profile games
              </span>
            </p>
          </div>
        </div>

        <ScoreTile
          label="Estimated likelihood"
          value={candidate.likelihood}
          tone="signal"
        />
        <ScoreTile
          label="Pattern match"
          value={candidate.patternMatch}
          tone="cyan"
        />

        <div className="grid min-w-0 gap-2 sm:grid-cols-2 md:col-span-3 xl:col-span-1">
          <EvidenceBar
            label="Build-order pattern"
            score={candidate.evidence.buildOrders?.score}
            targetSamples={candidate.evidence.buildOrders?.targetSamples}
            candidateSamples={candidate.evidence.buildOrders?.candidateSamples}
          />
          <EvidenceBar
            label="Control-group habits"
            score={candidate.evidence.controlGroups?.score}
            targetSamples={candidate.evidence.controlGroups?.targetSamples}
            candidateSamples={candidate.evidence.controlGroups?.candidateSamples}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 md:col-span-3 xl:col-span-1 xl:flex-col xl:items-stretch">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailId}
            onClick={() => setExpanded((current) => !current)}
            className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-full border-2 border-line bg-bg-surface px-4 font-display text-caption font-bold text-text shadow-hard transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {expanded ? "Hide evidence" : "Compare evidence"}
            <ChevronDown
              className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}
              aria-hidden
            />
          </button>
          <Link
            href={href}
            aria-label={`Open ${candidate.name || "candidate"} opponent dossier`}
            className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-full border-2 border-transparent px-4 font-display text-caption font-bold text-accent transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Open dossier
            <ArrowUpRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </div>

      {expanded ? (
        <CandidateEvidenceDetails id={detailId} candidate={candidate} />
      ) : null}
    </article>
  );
}

function EvidenceBadge({ confidence }: { confidence: EvidenceConfidence }) {
  const variant =
    confidence === "high"
      ? "cyan"
      : confidence === "medium"
        ? "accent"
        : "warning";
  return (
    <Badge variant={variant} size="sm">
      {confidence === "high"
        ? "High evidence"
        : confidence === "medium"
          ? "Medium evidence"
          : "Low evidence"}
    </Badge>
  );
}

function ScoreTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "signal" | "cyan";
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-elevated/45 px-3 py-2 text-left md:text-right">
      <p className="text-[0.625rem] uppercase tracking-wider text-text-dim">
        {label}
      </p>
      <p
        className={`mt-0.5 font-display text-h4 font-bold tabular-nums ${
          tone === "signal" ? "text-signal" : "text-accent-cyan"
        }`}
      >
        {formatPercent(value)}
      </p>
    </div>
  );
}

function EvidenceBar({
  label,
  score,
  targetSamples,
  candidateSamples,
}: {
  label: string;
  score: number | undefined;
  targetSamples: number | undefined;
  candidateSamples: number | undefined;
}) {
  const available = Number.isFinite(score);
  const percentage = toPercentage(score);
  return (
    <div className="min-w-0 rounded-lg border border-border bg-bg-elevated/25 p-2.5">
      <div className="flex items-start justify-between gap-2 text-micro">
        <span className="min-w-0 font-semibold text-text-muted">{label}</span>
        <span className="flex-none font-bold tabular-nums text-text">
          {available ? formatPercent(score as number) : "—"}
        </span>
      </div>
      {available ? (
        <div
          role="progressbar"
          aria-label={`${label} ${formatPercent(score as number)}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentage}
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-subtle"
        >
          <div
            className="h-full rounded-full bg-accent-cyan"
            style={{ width: `${percentage}%` }}
          />
        </div>
      ) : (
        <div className="mt-2 h-1.5 rounded-full bg-bg-subtle" aria-hidden />
      )}
      <p className="mt-1.5 text-[0.625rem] leading-relaxed text-text-dim">
        {available
          ? `${finiteCount(targetSamples)} target · ${finiteCount(candidateSamples)} candidate`
          : "Not enough comparable evidence"}
      </p>
    </div>
  );
}

function UnknownCandidate({
  unknownLikelihood,
  otherLikelihood,
}: {
  unknownLikelihood: number;
  otherLikelihood: number;
}) {
  return (
    <section
      className="rounded-xl border border-dashed border-border bg-bg-elevated/20 p-4"
      aria-label="Unlisted identity likelihoods"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-bg-elevated text-text-muted">
            <ShieldQuestion className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h3 className="text-caption font-semibold text-text">
              Unknown player
            </h3>
            <p className="mt-0.5 text-micro leading-relaxed text-text-muted">
              The barcode may belong to someone absent from every known profile
              compared in your replay history.
            </p>
          </div>
        </div>
        <div className="flex-none sm:text-right">
          <p className="font-display text-h4 font-bold tabular-nums text-text">
            {formatPercent(unknownLikelihood)}
          </p>
          <p className="text-[0.625rem] uppercase tracking-wider text-text-dim">
            Estimated likelihood
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3 text-micro text-text-muted">
        <p className="leading-relaxed">
          <span className="font-semibold text-text">Outside top five</span>{" "}
          <span>Known candidates ranked below the displayed matches.</span>
        </p>
        <span
          className="flex-none font-display text-caption font-bold tabular-nums text-text-muted"
          aria-label={`${formatPercent(otherLikelihood)} likelihood across known candidates outside the top five`}
        >
          {formatPercent(otherLikelihood)}
        </span>
      </div>
    </section>
  );
}

function UnverifiedNotice({
  response,
}: {
  response: OpponentIdentityCandidatesResponse;
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-warning/35 bg-warning/10 p-3 text-caption leading-relaxed text-text-muted">
      <ShieldQuestion className="mt-0.5 h-4 w-4 flex-none text-warning" aria-hidden />
      <p>
        <strong className="text-text">Treat these as scouting leads.</strong>{" "}
        Estimated likelihood is uncalibrated and includes an unknown-player
        hypothesis; pattern match measures behavioral closeness. Neither proves
        identity{response.calibrated ? "." : ", and no profile is linked automatically."}
      </p>
    </div>
  );
}

function MethodologyDetails({
  response,
}: {
  response: OpponentIdentityCandidatesResponse;
}) {
  return (
    <details className="group rounded-xl border border-border bg-bg-elevated/25">
      <summary className="flex min-h-[48px] cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 text-caption font-semibold text-text transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <CircleHelp className="h-4 w-4 flex-none text-accent-cyan" aria-hidden />
        <span>How identity matching works</span>
        <ChevronDown className="ml-auto h-4 w-4 flex-none text-text-dim transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="space-y-2 border-t border-border px-3 py-4 text-caption leading-relaxed text-text-muted sm:px-4">
        <p>
          The matcher compares classified opening sequences and their timings,
          plus logical control-group habits such as preferred slots, recall
          rhythm, and activity rate. Missing evidence is omitted instead of
          treated as a mismatch.
        </p>
        <p>
          <strong className="text-text">Pattern match</strong> is direct
          behavioral similarity. <strong className="text-text">Estimated
          likelihood</strong> also accounts for evidence quality and competes
          with every searched candidate and an explicit unknown hypothesis.
        </p>
        <p className="text-micro text-text-dim">
          Private scope: your replay history only · Method {response.methodologyVersion}
          {response.generatedAt
            ? ` · Generated ${formatGeneratedAt(response.generatedAt)}`
            : ""}
        </p>
      </div>
    </details>
  );
}

function evidenceModeLabel(mode: EvidenceMode | undefined): string {
  switch (mode) {
    case "build_and_control_groups":
      return "Build-order patterns and control-group habits are available";
    case "control_groups_only":
      return "This comparison currently uses control-group habits only";
    case "build_only":
      return "This comparison currently uses build-order patterns only";
    default:
      return "Replay behavior evidence is still forming";
  }
}

function formatGeneratedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return date.toLocaleString();
}

function validPositive(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
}

function clamp01(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function toPercentage(value: number | null | undefined): number {
  return Math.round(clamp01(value) * 100);
}

function formatPercent(value: number | null | undefined): string {
  const bounded = clamp01(value);
  if (bounded > 0 && bounded < 0.005) return "<1%";
  return `${Math.round(bounded * 100)}%`;
}
