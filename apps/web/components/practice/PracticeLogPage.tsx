"use client";

/**
 * /practice — the private practice log.
 *
 * The target per matchup is the account's synced Ghost Build assignment
 * (useGhostPractice); the grades come from the API, which graded each game
 * in that matchup when it uploaded. Owner-only: no coach, public or share
 * surface reads these grades.
 */

import { useState } from "react";
import { Crosshair } from "lucide-react";
import { useGhostPractice } from "@/lib/useGhostPractice";
import { GHOST_MATCHUPS, type GhostMatchupKey } from "@/lib/ghostBuild";
import { useApi } from "@/lib/clientApi";
import { practiceSummaryPath, type PracticeSummary } from "@/lib/practiceLog";
import { PageHeader } from "@/components/ui/PageHeader";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { LinkButton } from "@/components/ui/Button";
import { QueryState } from "@/components/ui/QueryState";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { RandomizerChallenge } from "./RandomizerChallenge";
import { PracticeSummaryView } from "./PracticeSummaryView";

export function PracticeLogPage() {
  const practice = useGhostPractice();
  const armed = GHOST_MATCHUPS.filter((matchup) => Boolean(practice.config.slots[matchup]));
  const [chosen, setChosen] = useState<GhostMatchupKey | null>(null);
  const [target, setTarget] = useState<{ matchup: GhostMatchupKey; hash: string } | null>(null);
  const matchup = chosen && armed.includes(chosen) ? chosen : armed[0] ?? null;
  const targetHash = target && target.matchup === matchup ? target.hash : null;
  const summary = useApi<PracticeSummary>(matchup ? practiceSummaryPath(matchup, targetHash) : null);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Build library" title="Practice log"
        description="Every game in a matchup with an armed Ghost Build target is graded when it uploads. Only you can see these grades."
        actions={<LazyHelpLink slug="practice-log">How the practice log works</LazyHelpLink>} />
      {!practice.owner ? (
        <p role="status" className="text-caption text-text-muted">Sign in to see your practice log.</p>
      ) : practice.loading ? (
        <SkeletonRows rows={4} label="Loading your practice targets" />
      ) : armed.length === 0 ? (
        <EmptyPractice offline={practice.offline} />
      ) : (
        <>
          {armed.length > 1 ? (
            <SegmentedControl label="Practised matchup" value={matchup!} onChange={setChosen}
              options={armed.map((key) => ({ value: key, label: key }))} />
          ) : null}
          <QueryState q={summary} skeleton={<SkeletonRows rows={6} label="Loading practice progress" />}>
            {(data, { isPreviousData }) => (
              <div className={isPreviousData ? "opacity-60" : undefined} aria-busy={isPreviousData || undefined}>
                <PracticeSummaryView summary={data} matchup={matchup!}
                  onSelectTarget={(hash) => setTarget(hash ? { matchup: matchup!, hash } : null)}
                  onGraded={() => void summary.mutate()} />
              </div>
            )}
          </QueryState>
        </>
      )}
      {practice.owner ? <RandomizerChallenge /> : null}
    </div>
  );
}

function EmptyPractice({ offline }: { offline: boolean }) {
  return (
    <section aria-labelledby="practice-empty" className="rounded-xl border border-dashed border-border p-6 text-center">
      <Crosshair className="mx-auto h-8 w-8 text-accent" aria-hidden />
      <h2 id="practice-empty" className="mt-3 text-h3 font-semibold text-text">Nothing to practise yet</h2>
      <p className="mx-auto mt-2 max-w-prose text-body text-text-muted">
        Arm a Ghost Build target for a matchup. From then on, every game you play in that matchup is graded against it automatically and your progress shows here.
      </p>
      {offline ? <p className="mt-2 text-caption text-warning">Your practice targets could not be loaded. Check your connection and reload.</p> : null}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
        <LinkButton href="/builds" iconLeft={<Crosshair className="h-4 w-4" aria-hidden />}>Choose a build to practice</LinkButton>
        <LazyHelpLink slug="practice-log" anchor="start">How to start</LazyHelpLink>
      </div>
    </section>
  );
}
