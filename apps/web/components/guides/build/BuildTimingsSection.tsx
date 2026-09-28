import { Section } from "@/components/ui/Section";
import { GuideCopyText } from "@/components/guides/GuideCopyText";
import { GuidePersonalComparison } from "@/components/guides/GuidePersonalComparison";
import {
  GUIDE_TABLE_CLASS,
  GUIDE_TABLE_WRAP_CLASS,
  GUIDE_TD_CLASS,
  GUIDE_TD_NUM_CLASS,
  GUIDE_TH_CLASS,
  GUIDE_TH_NUM_CLASS,
  GUIDE_THEAD_CLASS,
} from "@/components/guides/guideUi";
import { fmtClock, fmtCount } from "@/lib/guides/format";
import type { GuideCopyLine } from "@/lib/guides/guideCopy";
import type { GuideBuildPublished, GuideMilestone, GuideTimings } from "@/lib/guides/types";

/**
 * Section 3: key timings — p25 / median / p75 of the RECORDED build-log
 * time of each milestone (buildings when they start, upgrades and
 * morphs when they finish, as the event column says), plus the
 * winners-vs-losers medians where both sides cleared the floor, and the
 * viewer's own medians when signed in.
 */

/**
 * Milestone wording from its event.
 *
 * Example: `milestoneText({ label: "Stargate", event: "start" })` → "Stargate started".
 */
export function milestoneText(milestone: Pick<GuideMilestone, "label" | "event">): string {
  return `${milestone.label} ${milestone.event === "finish" ? "done" : "started"}`;
}

/**
 * Winners-vs-losers gap in whole seconds, from the SAME rounded medians
 * the row prints (so "4:30 vs 4:31" never reads "same"), or null
 * without both sides.
 *
 * Example: winners 436 s, losers 449 s → "13s earlier in wins".
 */
export function splitDelta(milestone: Pick<GuideMilestone, "winners" | "losers">): string | null {
  if (!milestone.winners || !milestone.losers) return null;
  const gap = Math.round(milestone.winners.median) - Math.round(milestone.losers.median);
  if (gap === 0) return "same in wins and losses";
  return `${Math.abs(gap)}s ${gap < 0 ? "earlier" : "later"} in wins`;
}

function SplitCell({ milestone }: { milestone: GuideMilestone }) {
  const delta = splitDelta(milestone);
  if (!milestone.winners || !milestone.losers || !delta) {
    return <span className="text-text-dim">—</span>;
  }
  return (
    <span className="block">
      <span className="text-success">{fmtClock(milestone.winners.median)}</span>
      <span className="text-text-dim"> vs </span>
      <span className="text-danger">{fmtClock(milestone.losers.median)}</span>
      <span className="block text-micro text-text-dim">{delta}</span>
    </span>
  );
}

function TimingsTable({ timings }: { timings: GuideTimings }) {
  const rows = [...timings.milestones].sort((a, b) => a.median - b.median);
  const hasSplit = rows.some((row) => row.winners && row.losers);
  return (
    <div className={GUIDE_TABLE_WRAP_CLASS}>
      <table className={GUIDE_TABLE_CLASS}>
        <caption className="sr-only">
          Key timings from {fmtCount(timings.samples)} recorded build orders, in game time
        </caption>
        <thead className={GUIDE_THEAD_CLASS}>
          <tr>
            <th scope="col" className={GUIDE_TH_CLASS}>Milestone</th>
            <th scope="col" className={GUIDE_TH_NUM_CLASS}>Early (p25)</th>
            <th scope="col" className={GUIDE_TH_NUM_CLASS}>Median</th>
            <th scope="col" className={GUIDE_TH_NUM_CLASS}>Late (p75)</th>
            {hasSplit ? <th scope="col" className={GUIDE_TH_NUM_CLASS}>Wins vs losses</th> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" className={`${GUIDE_TD_CLASS} text-left font-medium`}>
                {milestoneText(row)}
                <span className="block text-micro font-normal text-text-dim">
                  in {fmtCount(row.games)} games
                </span>
              </th>
              <td className={GUIDE_TD_NUM_CLASS}>{fmtClock(row.p25)}</td>
              <td className={`${GUIDE_TD_NUM_CLASS} font-semibold text-text`}>{fmtClock(row.median)}</td>
              <td className={GUIDE_TD_NUM_CLASS}>{fmtClock(row.p75)}</td>
              {hasSplit ? (
                <td className={GUIDE_TD_NUM_CLASS}>
                  <SplitCell milestone={row} />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BuildTimingsSection({
  payload,
  blurb,
}: {
  payload: GuideBuildPublished;
  blurb: ReadonlyArray<GuideCopyLine>;
}) {
  const { timings } = payload;
  if (!timings || timings.milestones.length === 0) return null;
  const community = timings.milestones.map(({ key, label, event, median }) => ({
    key,
    label,
    event,
    median,
  }));
  return (
    <Section id="key-timings" title="Key timings">
      <div className="space-y-4">
        <GuideCopyText lines={blurb} />
        <TimingsTable timings={timings} />
        <GuidePersonalComparison
          matchupSlug={payload.matchupSlug}
          buildSlug={payload.buildSlug}
          buildName={payload.name}
          community={community}
        />
      </div>
    </Section>
  );
}
