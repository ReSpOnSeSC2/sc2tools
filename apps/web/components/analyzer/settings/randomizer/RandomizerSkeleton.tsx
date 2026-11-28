/**
 * Settings → Randomizer while its settings load, shaped like
 * `MatchupSection` row for row: the heading and its line, then the race,
 * matchup, switch and desktop-roll rows. Rows of words hold the real copy
 * without its ink, so they wrap exactly where the loaded card does at any
 * width and nothing moves when the settings arrive.
 */
import { SkeletonCard, SkeletonRegion } from "@/components/ui/Skeleton";
import { emptyMatchupConfig } from "@/lib/randomizer/config";
import { MATCHUPS } from "@/lib/randomizer/types";
import { DRAW_SWITCH_COPY, drawSummary } from "./DrawSwitches";
import { DESKTOP_ROLL_COPY, RANDOMIZER_INTRO } from "./MatchupSection";

/** Copy that keeps its line breaks but not its ink: one bar per line, as long as the line. */
function Ghost({ className, children }: { className: string; children: string }) {
  return (
    <span className={["block select-none text-transparent", className].join(" ")}>
      <span className="rounded-md skeleton-shimmer box-decoration-clone">{children}</span>
    </span>
  );
}

/** A control-shaped block; its own radius, so a pill stays a pill. */
function Block({ className }: { className: string }) {
  return <div aria-hidden className={["skeleton-shimmer", className].join(" ")} />;
}

function SwitchGhost({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-11 items-start justify-between gap-3 rounded-lg border border-border bg-bg-elevated px-3 py-2.5">
      <span className="min-w-0 flex-1">
        {/* The title's icon and gap come first. */}
        <span className="block pl-6"><Ghost className="text-body font-medium">{title}</Ghost></span>
        <Ghost className="mt-0.5 text-caption">{description}</Ghost>
      </span>
      <Block className="mt-0.5 h-6 w-11 shrink-0 rounded-full" />
    </div>
  );
}

export function RandomizerSkeleton() {
  return (
    <SkeletonRegion label="Loading randomizer settings" className="space-y-4">
      <div aria-hidden className="space-y-1">
        {/* The title starts after its spine. */}
        <Ghost className="ml-4 text-h4 font-bold tracking-tight">Build randomizer</Ghost>
        <Ghost className="text-body">{RANDOMIZER_INTRO}</Ghost>
      </div>
      <SkeletonCard>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <Ghost className="text-caption font-semibold">Your race</Ghost>
            <Block className="h-[54px] w-72 max-w-full rounded-full sm:h-[42px]" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[0, 1, 2].map((index) => <Block key={index} className="h-[82px] rounded-lg" />)}
          </div>
        </div>
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <Ghost className="text-caption font-semibold">What to draw</Ghost>
          <div className="grid gap-2 sm:grid-cols-2">
            <SwitchGhost {...DRAW_SWITCH_COPY.build} />
            <SwitchGhost {...DRAW_SWITCH_COPY.units} />
          </div>
          <Ghost className="text-caption">{drawSummary(MATCHUPS[0], emptyMatchupConfig())}</Ghost>
        </div>
        <div className="mt-4 flex min-h-11 items-start gap-3 border-t border-border pt-4">
          <Block className="mt-1 h-4 w-4 shrink-0 rounded" />
          <span className="min-w-0">
            <Ghost className="text-body font-medium">{DESKTOP_ROLL_COPY.title}</Ghost>
            <Ghost className="mt-1 text-caption">{DESKTOP_ROLL_COPY.description}</Ghost>
          </span>
        </div>
      </SkeletonCard>
    </SkeletonRegion>
  );
}
