import type { ReactNode } from "react";
import { Activity, Keyboard, ListChecks, ShieldQuestion } from "lucide-react";

import { Badge } from "@/components/ui";
import type {
  BuildOrderMatchEvidence,
  ActionMatchEvidence,
  BehaviorMatchDimension,
  ControlGroupMatchEvidence,
  ControlGroupOpeningStep,
  IdentityCandidate,
} from "./OpponentIdentityCandidates";

/** Expandable, evidence-by-evidence explanation for one identity lead. */
export function CandidateEvidenceDetails({
  id,
  candidate,
  showReplayActions = false,
}: {
  id: string;
  candidate: IdentityCandidate;
  showReplayActions?: boolean;
}) {
  const build = candidate.evidence.buildOrders;
  const control = candidate.evidence.controlGroups;
  const actions = candidate.evidence.actions;
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
              {build.detailLevel === "labels_only" ? (
                <p className="mt-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-micro leading-relaxed text-warning">
                  Only classified build labels can be compared. These common
                  strategies provide little identity evidence without recorded opening timings.
                </p>
              ) : null}
              {build.milestoneSamples ? (
                <p className="mt-2 text-micro text-text-dim">
                  Recorded opening timings: {finiteCount(build.milestoneSamples.target)} target games ·{" "}
                  {finiteCount(build.milestoneSamples.candidate)} candidate games
                </p>
              ) : null}
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
          {control?.advancedSamples ? (
            <p className="mt-3 text-micro leading-relaxed text-text-dim">
              Detailed control-group evidence: {finiteCount(control.advancedSamples.target)} target games ·{" "}
              {finiteCount(control.advancedSamples.candidate)} candidate games.
              {control.advancedSamples.target === 0 || control.advancedSamples.candidate === 0
                ? " Reprocess older replays to compare detailed timing and usage patterns."
                : ""}
            </p>
          ) : null}
          <MembershipComparison evidence={control} />
          <OpeningComparison examples={control?.openingExamples} />
          <DimensionComparison dimensions={control?.dimensions} title="Control-group measurements" />
        </EvidenceDetailCard>
      </div>

      {showReplayActions || actions ? (
        <div className="mt-3">
          <EvidenceDetailCard
            icon={<Activity className="h-4 w-4" aria-hidden />}
            title="Replay-action habits"
            evidence={actions}
          >
            <CameraComparison habits={actions?.cameraHabits} />
            <DimensionComparison dimensions={actions?.dimensions} title="Replay-action measurements" />
          </EvidenceDetailCard>
        </div>
      ) : null}

      <p className="mt-3 text-micro leading-relaxed text-text-dim">
        Logical groups and game actions come from the replay. Physical keystrokes,
        keyboard layout, and custom key bindings are not recorded.
      </p>

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
  | ActionMatchEvidence
  | null
  | undefined;

function MembershipComparison({ evidence }: { evidence?: ControlGroupMatchEvidence | null }) {
  const samples = evidence?.membershipSamples;
  if (!samples) return null;
  const habits = (evidence?.membershipHabits || []).slice(0, 24);
  return (
    <div className="mt-3">
      <p className="text-micro leading-relaxed text-text-dim">
        Decoded group membership: {finiteCount(samples.target)} target games ·{" "}
        {finiteCount(samples.candidate)} candidate games. Two groups in one row
        mean the same unit was recorded in both groups. Typical first times are
        medians across games where the habit was observed.
        {!samples.target || !samples.candidate
          ? " Reprocess older replays to compare assigned units and buildings."
          : ""}
      </p>
      {habits.length ? (
        <div className="mt-2 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-micro">
            <caption className="border-b border-border bg-bg-elevated/30 px-3 py-2 text-left font-semibold text-text">
              Units and buildings assigned to groups
            </caption>
            <ComparisonHead label="Recorded membership" />
            <tbody className="divide-y divide-border">
              {habits.map((habit) => (
                <tr key={`${habit.unitType}-${habit.slots.join("-")}`}>
                  <th scope="row" className="min-w-[9rem] px-3 py-2 align-top font-medium text-text-muted">
                    {habit.unitType}
                    <span className="mt-0.5 block text-text-dim">
                      {habit.slots.length > 1 ? "Same unit · groups " : "Group "}
                      {habit.slots.join(" + ")}
                    </span>
                  </th>
                  <td className="px-3 py-2 text-right align-top tabular-nums text-text-muted">
                    <HabitObservation games={habit.targetGames} samples={samples.target} firstSec={habit.targetFirstSec} />
                  </td>
                  <td className="px-3 py-2 text-right align-top tabular-nums text-text-muted">
                    <HabitObservation games={habit.candidateGames} samples={samples.candidate} firstSec={habit.candidateFirstSec} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-2 text-micro text-text-dim">No decoded assignment habits are available to display.</p>
      )}
    </div>
  );
}

function HabitObservation({ games, samples, firstSec }: {
  games: number;
  samples: number;
  firstSec?: number;
}) {
  const observed = finiteCount(games);
  const total = finiteCount(samples);
  if (!total) return <span>No decoded games</span>;
  return (
    <>
      <span>{observed ? `${observed} / ${total} games` : `Not observed in ${total} games`}</span>
      {observed > 0 && typeof firstSec === "number" && Number.isFinite(firstSec) ? (
        <span className="mt-0.5 block whitespace-nowrap text-text-dim">Typical first at {formatGameTime(firstSec)}</span>
      ) : null}
    </>
  );
}

function OpeningComparison({ examples }: { examples?: ControlGroupMatchEvidence["openingExamples"] }) {
  if (!examples) return null;
  return (
    <section className="mt-3 rounded-lg border border-border p-3" aria-label="Opening group examples">
      <h5 className="text-micro font-semibold text-text">Opening group examples</h5>
      <p className="mt-1 text-micro leading-relaxed text-text-dim">
        Recorded assignments and recalls from the newest replay with decoded opening actions on each side.
        These are individual game examples; repeated habits are summarized above.
      </p>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <OpeningSequence label="Target opening" steps={examples.target} />
        <OpeningSequence label="Candidate opening" steps={examples.candidate} />
      </div>
    </section>
  );
}

function OpeningSequence({ label, steps }: { label: string; steps: ControlGroupOpeningStep[] }) {
  return (
    <div>
      <h6 className="text-micro font-semibold text-text-muted">{label}</h6>
      {steps.length ? (
        <ol className="mt-1 space-y-2 text-micro" aria-label={label}>
          {steps.slice(0, 12).map((step, index) => (
            <li key={`${step.atSec}-${step.slot}-${index}`} className="text-text-muted">
              <span className="font-medium tabular-nums text-text">{formatGameTime(step.atSec)}</span>
              {" · "}{assignmentAction(step.action)} group {step.slot}
              <span className="block text-text-dim">
                {step.units.length
                  ? step.units.slice(0, 12).map((unit) => `${unit.name} ×${finiteCount(unit.count)}`).join(", ")
                  : "Unit membership unavailable"}
              </span>
            </li>
          ))}
        </ol>
      ) : <p className="mt-1 text-micro text-text-dim">No decoded opening group actions</p>}
    </div>
  );
}

function assignmentAction(action: string): string {
  switch (action) {
    case "set": return "Set";
    case "add": return "Add to";
    case "stealSet": return "Steal into";
    case "stealAdd": return "Steal and add to";
    case "recall": return "Recall";
    default: return "Update";
  }
}

function CameraComparison({ habits }: { habits?: ActionMatchEvidence["cameraHabits"] }) {
  if (!habits) return null;
  return (
    <section className="mt-3" aria-label="Camera bookmark evidence">
      <p className="text-micro leading-relaxed text-text-dim">
        Camera bookmark evidence: {finiteCount(habits.targetSamples)} target games ·{" "}
        {finiteCount(habits.candidateSamples)} candidate games. Slots 0–7 are replay
        identifiers. A return to a saved position is inferred from camera movement;
        it does not confirm a hotkey press or identify a physical key. Typical
        first times are medians across games where the bookmark was saved.
      </p>
      {habits.slots.length ? (
        <div className="mt-2 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-micro">
            <caption className="border-b border-border bg-bg-elevated/30 px-3 py-2 text-left font-semibold text-text">
              Camera bookmark slots
            </caption>
            <ComparisonHead label="Recorded slot" />
            <tbody className="divide-y divide-border">
              {habits.slots.slice(0, 8).map((slot) => (
                <tr key={slot.slot}>
                  <th scope="row" className="px-3 py-2 align-top font-medium text-text-muted">Bookmark slot {slot.slot}</th>
                  <td className="px-3 py-2 text-right align-top tabular-nums text-text-muted">
                    <HabitObservation games={slot.targetGames} samples={habits.targetSamples} firstSec={slot.targetFirstSaveSec} />
                    <CameraRates saves={slot.targetSavesPerGame} returns={slot.targetReturnsPerGame} />
                  </td>
                  <td className="px-3 py-2 text-right align-top tabular-nums text-text-muted">
                    <HabitObservation games={slot.candidateGames} samples={habits.candidateSamples} firstSec={slot.candidateFirstSaveSec} />
                    <CameraRates saves={slot.candidateSavesPerGame} returns={slot.candidateReturnsPerGame} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-2 text-micro text-text-dim">
          {habits.targetSamples || habits.candidateSamples
            ? "No bookmark saves were observed in the decoded games."
            : "No decoded camera bookmark evidence is available. Reprocess older replays to add it."}
        </p>
      )}
    </section>
  );
}

function CameraRates({ saves, returns }: { saves?: number; returns?: number }) {
  return (
    <>
      {typeof saves === "number" && Number.isFinite(saves) ? (
        <span className="mt-0.5 block text-text-dim">{formatDimensionValue(saves)} saves/game</span>
      ) : null}
      {typeof returns === "number" && Number.isFinite(returns) ? (
        <span className="mt-0.5 block text-text-dim">{formatDimensionValue(returns)} inferred returns/game</span>
      ) : null}
    </>
  );
}

function ComparisonHead({ label }: { label: string }) {
  return (
    <thead className="border-b border-border text-text-dim">
      <tr>
        <th scope="col" className="px-3 py-2 font-medium">{label}</th>
        <th scope="col" className="px-3 py-2 text-right font-medium">Target</th>
        <th scope="col" className="px-3 py-2 text-right font-medium">Candidate</th>
      </tr>
    </thead>
  );
}

function formatGameTime(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "Unavailable";
  const seconds = Math.round(value * 10) / 10;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}

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
            {finiteCount(evidence.targetSamples)} target games ·{" "}
            {finiteCount(evidence.candidateSamples)} candidate games
          </p>
          {"targetEvents" in evidence && "candidateEvents" in evidence ? (
            <p className="mt-1 text-micro text-text-dim">
              Recorded events: {finiteCount(evidence.targetEvents).toLocaleString()} target ·{" "}
              {finiteCount(evidence.candidateEvents).toLocaleString()} candidate
            </p>
          ) : null}
          {"consistency" in evidence && evidence.consistency ? (
            <p className="mt-1 text-micro leading-relaxed text-text-dim">
              {"matchedSlots" in evidence
                ? "Consistency of group usage across games"
                : "Consistency of action mix across games"}: target{" "}
              {formatConsistency(evidence.consistency.target)} · candidate{" "}
              {formatConsistency(evidence.consistency.candidate)}.
            </p>
          ) : null}
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

function DimensionComparison({
  dimensions,
  title,
}: {
  dimensions?: BehaviorMatchDimension[];
  title: string;
}) {
  if (!dimensions?.length) return null;

  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-micro">
        <caption className="border-b border-border bg-bg-elevated/30 px-3 py-2 text-left font-semibold text-text">
          {title}
        </caption>
        <thead className="border-b border-border text-text-dim">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Measurement</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Target</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Candidate</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Similarity</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {dimensions.map((dimension) => (
            <tr key={dimension.key}>
              <th scope="row" className="min-w-[8rem] px-3 py-2 align-top font-medium text-text-muted">
                {dimension.label}
              </th>
              <td className="px-3 py-2 text-right align-top tabular-nums text-text-muted">
                <DimensionValue value={dimension.targetValue} unit={dimension.unit} samples={dimension.targetSamples} />
              </td>
              <td className="px-3 py-2 text-right align-top tabular-nums text-text-muted">
                <DimensionValue value={dimension.candidateValue} unit={dimension.unit} samples={dimension.candidateSamples} />
              </td>
              <td className="px-3 py-2 text-right align-top font-semibold tabular-nums text-accent-cyan">
                {typeof dimension.score === "number" && Number.isFinite(dimension.score)
                  ? formatPercent(dimension.score)
                  : <span className="font-normal text-text-dim">Unavailable</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DimensionValue({ value, unit, samples }: {
  value?: number;
  unit?: string;
  samples: number;
}) {
  const available = typeof value === "number" && Number.isFinite(value);
  const count = finiteCount(samples);
  return (
    <>
      {available ? <span className="whitespace-nowrap">{formatDimensionValue(value, unit)}</span> : null}
      <span className={`whitespace-nowrap ${available ? "mt-0.5 block text-[0.625rem] text-text-dim" : ""}`}>
        {count === 0 ? "No samples" : `${count} ${count === 1 ? "game" : "games"}`}
      </span>
    </>
  );
}

function formatDimensionValue(value: number, unit?: string): string {
  if (unit === "ratio") return formatPercent(value);
  const number = value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (unit === "per_minute") return `${number}/min`;
  if (unit === "seconds") return `${number}s`;
  if (!unit || unit === "count") return number;
  return `${number} ${unit}`;
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
    case "labels_only_build_evidence":
      return "Build similarity is based on shared strategy labels without comparable opening timings. Common strategies are weak identity evidence.";
    case "legacy_control_group_signature":
      return "Older replay signatures have limited control-group detail. Reprocessing the source replays adds timing and usage evidence.";
    case "legacy_steal_events_reprocess":
      return "Older signatures containing group steals were excluded from behavior comparison because their automatic replay events cannot be separated. Re-sync those source replays to include them.";
    case "sparse_control_group_events":
      return "Too few recorded control-group events are available for a dependable comparison of habits.";
    case "sparse_action_events":
      return "Too few recorded actions are available for a dependable comparison of action habits.";
    case "inconsistent_behavior":
      return "Behavior varies between the available games, reducing confidence in a consistent player pattern.";
    case "ambiguous_candidates":
      return "Other candidates have similarly close patterns; these results do not distinguish one player clearly.";
    case "limited_candidate_search":
      return "The comparison reached a search limit, so another matching player may be outside the evidence examined.";
    default:
      return caveat.replaceAll("_", " ");
  }
}

function finiteCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
}

function formatConsistency(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value)
    ? formatPercent(value)
    : "needs repeated games";
}

function formatPercent(value: number | null | undefined): string {
  const bounded = typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
  if (bounded > 0 && bounded < 0.005) return "<1%";
  return `${Math.round(bounded * 100)}%`;
}
