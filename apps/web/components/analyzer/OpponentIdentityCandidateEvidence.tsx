import type { ReactNode } from "react";
import { Keyboard, ListChecks, ShieldQuestion } from "lucide-react";

import { Badge } from "@/components/ui";
import type {
  BuildOrderMatchEvidence,
  ControlGroupMatchEvidence,
  IdentityCandidate,
} from "./OpponentIdentityCandidates";

/** Expandable, evidence-by-evidence explanation for one identity lead. */
export function CandidateEvidenceDetails({
  id,
  candidate,
}: {
  id: string;
  candidate: IdentityCandidate;
}) {
  const build = candidate.evidence.buildOrders;
  const control = candidate.evidence.controlGroups;
  return (
    <div id={id} className="mt-4 border-t border-border pt-4">
      <div className="grid gap-3 lg:grid-cols-2">
        <EvidenceDetailCard
          icon={<ListChecks className="h-4 w-4" aria-hidden />}
          title="Build-order pattern"
          evidence={build}
        >
          {build ? (
            <>
              {build.sharedBuilds.length > 0 ? (
                <EvidenceChips
                  label="Shared builds"
                  values={build.sharedBuilds}
                />
              ) : null}
              {build.sharedMilestones.length > 0 ? (
                <div className="mt-3">
                  <p className="text-micro font-semibold uppercase tracking-wider text-text-dim">
                    Closest opening timings
                  </p>
                  <ul className="mt-1.5 space-y-1 text-caption text-text-muted">
                    {build.sharedMilestones.map((milestone, index) => (
                      <li key={`${milestone.name}-${index}`}>
                        <span className="text-text">{milestone.name}</span>
                        {Number.isFinite(milestone.deltaSec)
                          ? ` · within ${Math.max(0, Math.round(milestone.deltaSec))}s`
                          : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}
        </EvidenceDetailCard>

        <EvidenceDetailCard
          icon={<Keyboard className="h-4 w-4" aria-hidden />}
          title="Control-group habits"
          evidence={control}
        >
          {control && control.matchedSlots.length > 0 ? (
            <EvidenceChips
              label="Matching logical groups"
              values={control.matchedSlots.map((slot) => `Group ${slot}`)}
            />
          ) : null}
        </EvidenceDetailCard>
      </div>

      <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border bg-bg-elevated/25 p-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="text-caption leading-relaxed text-text-muted">
          Evidence coverage {formatPercent(candidate.evidence.coverage)} · based
          on {finiteCount(candidate.sample.targetEvidenceGames)} target and{" "}
          {finiteCount(candidate.sample.candidateEvidenceGames)} candidate
          evidence games.
        </p>
        <span className="flex-none text-micro font-semibold tabular-nums text-text-dim">
          Quality {formatPercent(candidate.evidenceQuality)}
        </span>
      </div>

      {candidate.caveats.length > 0 ? (
        <ul className="mt-3 space-y-1.5" aria-label="Candidate limitations">
          {candidate.caveats.map((caveat) => (
            <li
              key={caveat}
              className="flex items-start gap-2 text-micro leading-relaxed text-warning"
            >
              <ShieldQuestion
                className="mt-0.5 h-3.5 w-3.5 flex-none"
                aria-hidden
              />
              <span>{friendlyCaveat(caveat)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

type DetailEvidence =
  | BuildOrderMatchEvidence
  | ControlGroupMatchEvidence
  | null
  | undefined;

function EvidenceDetailCard({
  icon,
  title,
  evidence,
  children,
}: {
  icon: ReactNode;
  title: string;
  evidence: DetailEvidence;
  children?: ReactNode;
}) {
  const highlights = evidence?.highlights || [];
  return (
    <section className="min-w-0 rounded-xl border border-border bg-bg-elevated/25 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-accent-cyan">
          {icon}
          <h4 className="text-caption font-semibold text-text">{title}</h4>
        </div>
        <span className="flex-none font-display text-body font-bold tabular-nums text-accent-cyan">
          {evidence ? formatPercent(evidence.score) : "—"}
        </span>
      </div>
      {evidence ? (
        <>
          <p className="mt-2 text-micro text-text-dim">
            {finiteCount(evidence.targetSamples)} target samples ·{" "}
            {finiteCount(evidence.candidateSamples)} candidate samples
          </p>
          {children}
          {highlights.length > 0 ? (
            <ul className="mt-3 space-y-1.5 text-caption text-text-muted">
              {highlights.map((highlight, index) => (
                <li key={`${highlight}-${index}`} className="flex gap-2">
                  <span
                    className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full bg-accent-cyan"
                    aria-hidden
                  />
                  <span>{highlight}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="mt-3 rounded-lg border border-dashed border-border p-3 text-caption text-text-dim">
          This evidence channel was not available for both profiles.
        </p>
      )}
    </section>
  );
}

function EvidenceChips({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="mt-3">
      <p className="text-micro font-semibold uppercase tracking-wider text-text-dim">
        {label}
      </p>
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {values.map((value, index) => (
          <li key={`${value}-${index}`}>
            <Badge variant="neutral" size="sm" className="max-w-full">
              <span className="truncate" title={value}>
                {value}
              </span>
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

function friendlyCaveat(caveat: string): string {
  switch (caveat) {
    case "build_only_reprocess_for_control_groups":
      return "Control-group habits were unavailable for one side, so this lead relies on build-order evidence.";
    case "control_groups_only_no_build_match":
      return "Build-order evidence was unavailable for one side, so this lead relies on control-group habits.";
    case "single_target_replay":
      return "Only one target replay contributed evidence; treat this lead as especially tentative.";
    default:
      return caveat.replaceAll("_", " ");
  }
}

function finiteCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
}

function formatPercent(value: number | null | undefined): string {
  const bounded = typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
  if (bounded > 0 && bounded < 0.005) return "<1%";
  return `${Math.round(bounded * 100)}%`;
}
