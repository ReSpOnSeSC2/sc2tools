import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { GuideSection as Section } from "@/components/guides/GuideSection";
import { GuideMarkdown } from "@/lib/guides/markdown";
import { WinRateCell } from "@/components/guides/WinRateCell";
import { guidePaths } from "@/components/guides/guideMetadata";
import { GUIDE_LINK_CLASS, GUIDE_PANEL_CLASS } from "@/components/guides/guideUi";
import { PublicReplayDownloadButton } from "@/components/public-profile/PublicReplayDownloadButton";
import { fmtClock, fmtCount, fmtCountNoun, fmtGuideDate, fmtPct } from "@/lib/guides/format";
import type {
  GuideCommunityBuildLink,
  GuideExampleReplay,
  GuideLeaks,
  GuideMacro,
  GuideNotes,
  GuideRelatedBuild,
} from "@/lib/guides/types";
import { hasCommunityBuildLink, hasExampleReplayLink } from "./buildGuideSections";

/**
 * Build guide sections 8 (common macro leaks), 9 (related openers,
 * community builds, example replays) and 10 (coach's notes). Each hides
 * itself when its data is empty.
 */

const MACRO_SCORE_DECIMALS = 1;

export function BuildLeaksSection({ leaks, macro }: { leaks: GuideLeaks | null; macro: GuideMacro | null }) {
  const items = leaks?.items ?? [];
  if (items.length === 0 && !macro) return null;
  return (
    <Section id="macro-leaks" title="Common macro leaks">
      <div className={`${GUIDE_PANEL_CLASS} space-y-3 p-4`}>
        {macro ? (
          <p className="text-body text-text-muted">
            Average macro score{" "}
            <span className="font-semibold tabular-nums text-text">
              {macro.avgScore.toFixed(MACRO_SCORE_DECIMALS)}
            </span> over{" "}
            {fmtCount(macro.games)} games from {fmtCountNoun(macro.users, "player")}.
          </p>
        ) : null}
        {items.length > 0 && leaks ? (
          <ul className="divide-y divide-border">
            {items.map((item) => (
              <li key={item.name} className="flex items-center justify-between gap-3 py-2 text-caption">
                <span className="font-medium text-text">{item.name}</span>
                <span className="text-right tabular-nums text-text-muted">
                  in {fmtPct(item.share)} of games
                  <span className="block text-micro text-text-dim">
                    {fmtCount(item.games)} of {fmtCount(leaks.games)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Section>
  );
}

function RelatedOpeners({ related, matchupSlug }: { related: ReadonlyArray<GuideRelatedBuild>; matchupSlug: string }) {
  if (related.length === 0) return null;
  return (
    <div className={`${GUIDE_PANEL_CLASS} min-w-0 p-4`}>
      <h3 className="mb-2 font-display text-h4 font-bold text-text">Other openers in this matchup</h3>
      <ul className="divide-y divide-border">
        {related.map((row) => (
          <li key={row.buildKey} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0 text-caption">
              {row.published ? (
                <Link href={guidePaths.build(matchupSlug, row.buildSlug)} className={GUIDE_LINK_CLASS}>
                  {row.name}
                </Link>
              ) : (
                <span className="text-text">{row.name}</span>
              )}
              <span className="block text-micro text-text-dim">{fmtCount(row.games)} games</span>
            </span>
            <WinRateCell winRate={row.winRate} ci={row.ci} showWhisker={false} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function CommunityBuilds({ builds }: { builds: ReadonlyArray<GuideCommunityBuildLink> }) {
  if (builds.length === 0) return null;
  return (
    <div className="space-y-1">
      <h3 className="text-caption font-semibold uppercase tracking-wider text-text-dim">Community builds</h3>
      <ul className="space-y-1 text-caption">
        {builds.map((build) => (
          <li key={build.slug}>
            <Link href={`/community/builds/${build.slug}`} className={GUIDE_LINK_CLASS}>
              {build.title}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExampleReplays({ examples }: { examples: ReadonlyArray<GuideExampleReplay> }) {
  if (examples.length === 0) return null;
  return (
    <div className={`${GUIDE_PANEL_CLASS} min-w-0 p-4`}>
      <h3 className="mb-1 font-display text-h4 font-bold text-text">Example replays</h3>
      <ul className="divide-y divide-border text-caption">
        {examples.map((example) => {
          const player = example.displayName ?? example.handle;
          const replayLabel = example.map ? `${player} on ${example.map}` : player;
          return (
            <li key={`${example.handle}-${example.replayRef}`} className="space-y-2 py-3">
              <p className="break-words font-semibold text-text">{player}</p>
              <p className="break-words text-text-muted">
                {example.result}
                {example.map ? ` on ${example.map}` : ""}
                {example.durationSec !== null ? ` · ${fmtClock(example.durationSec)}` : ""}
                {` · ${fmtGuideDate(example.playedAt)}`}
              </p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Link
                  href={example.href}
                  prefetch={false}
                  aria-label={`View replay — ${replayLabel}`}
                  className={`${GUIDE_LINK_CLASS} inline-flex min-h-11 items-center gap-1.5`}
                >
                  View replay <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
                <PublicReplayDownloadButton
                  handle={example.handle}
                  gameId={example.replayRef}
                  available
                  showLabel
                  contextLabel={replayLabel}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function BuildRelatedSection({
  related,
  communityBuilds,
  examples,
  matchupSlug,
}: {
  related: ReadonlyArray<GuideRelatedBuild>;
  communityBuilds: ReadonlyArray<GuideCommunityBuildLink>;
  examples: ReadonlyArray<GuideExampleReplay>;
  matchupSlug: string;
}) {
  const communityLinks = communityBuilds.filter(hasCommunityBuildLink);
  const replayLinks = examples.filter(hasExampleReplayLink);
  const hasLinks = communityLinks.length > 0 || replayLinks.length > 0;
  if (related.length === 0 && !hasLinks) return null;
  return (
    <Section id="related" title="Related">
      <div className={`grid items-start gap-4${related.length > 0 && hasLinks ? " md:grid-cols-2" : ""}`}>
        <RelatedOpeners related={related} matchupSlug={matchupSlug} />
        {hasLinks ? (
          <div className="min-w-0 space-y-4">
            <ExampleReplays examples={replayLinks} />
            <CommunityBuilds builds={communityLinks} />
          </div>
        ) : null}
      </div>
    </Section>
  );
}

export function BuildNotesSection({ notes }: { notes: GuideNotes | null }) {
  if (!notes || !notes.body.trim()) return null;
  return (
    <Section id="coach-notes" title="Coach's notes" description={`Updated ${fmtGuideDate(notes.updatedAt)}`}>
      <div className={`${GUIDE_PANEL_CLASS} p-4`}>
        <GuideMarkdown source={notes.body} />
      </div>
    </Section>
  );
}
