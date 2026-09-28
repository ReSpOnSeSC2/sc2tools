"use client";

/**
 * PlayerChooser — "Which player are you?" when the replays alone don't say
 * (loose files without a toon folder). One tap per candidate
 * (`name · race · N games`, most frequent first); "None of these" cancels
 * the run. The heading is focused on mount and sits in a polite live
 * region, so keyboard and screen-reader users land on the question.
 *
 * Example:
 *   {session.phase === "choosing" ? (
 *     <PlayerChooser candidates={session.candidates} onChoose={(toon) => void session.choose(toon)} onCancel={session.cancel} />
 *   ) : null}
 */
import { useEffect, useId, useRef } from "react";
import { UserRound } from "lucide-react";
import { Button } from "@/components/ui";
import type { MeCandidate } from "@/lib/instant/meDetection";

export interface PlayerChooserProps {
  candidates: MeCandidate[];
  onChoose: (toon: string) => void;
  onCancel: () => void;
  className?: string;
}

const UNNAMED = "Unnamed player";

/**
 * Button text for one candidate.
 *
 * Example:
 *   candidateLabel({ toon: "1-S2-1-1", name: "Rex", race: "Zerg", games: 3 }); // -> "Rex · Zerg · 3 games"
 */
export function candidateLabel(candidate: MeCandidate): string {
  const games = `${candidate.games} ${candidate.games === 1 ? "game" : "games"}`;
  return [candidate.name || UNNAMED, candidate.race, games].filter(Boolean).join(" · ");
}

/**
 * One-tap "which player is me?" picker.
 *
 * Example:
 *   <PlayerChooser candidates={candidates} onChoose={choose} onCancel={cancel} />
 */
export function PlayerChooser({ candidates, onChoose, onCancel, className = "" }: PlayerChooserProps) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section
      aria-labelledby={headingId}
      className={["space-y-4 rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard", className].filter(Boolean).join(" ")}
    >
      <div aria-live="polite" className="space-y-1">
        <h2 id={headingId} ref={heading} tabIndex={-1} className="font-display text-h3 text-text focus:outline-none">
          Which player are you?
        </h2>
        <p className="text-caption text-text-muted">
          These replays don&apos;t say which side is yours. Pick yourself so every game is analyzed from your point of view.
        </p>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {candidates.map((candidate) => (
          <li key={candidate.toon}>
            <button
              type="button"
              onClick={() => onChoose(candidate.toon)}
              className={[
                "flex min-h-[44px] w-full items-center gap-2 rounded-lg border-2 border-line bg-bg-surface px-3 py-2 text-left",
                "text-body font-semibold text-text transition-colors motion-reduce:transition-none",
                "hover:border-accent hover:bg-bg-elevated",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
              ].join(" ")}
            >
              <UserRound className="h-4 w-4 flex-shrink-0 text-text-muted" aria-hidden />
              <span className="min-w-0 break-words">{candidateLabel(candidate)}</span>
            </button>
          </li>
        ))}
      </ul>
      <Button variant="ghost" onClick={onCancel}>
        None of these
      </Button>
    </section>
  );
}
