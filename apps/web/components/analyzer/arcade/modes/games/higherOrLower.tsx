"use client";

import { useMemo, useState } from "react";
import { Heart } from "lucide-react";
import { pct1, wrColor } from "@/lib/format";
import { Icon } from "@/components/ui/Icon";
import { coerceRace, raceIconName } from "@/lib/race";
import { GameStage } from "../../shells/GameStage";
import { IconFor } from "../../icons";
import { registerMode, shuffle } from "../../ArcadeEngine";
import { buildUniverse, type UnifiedBuild } from "../../sessions";
import { useArcadeState } from "../../hooks/useArcadeState";
import type {
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
  ShareSummary,
} from "../../types";

const ID = "higher-or-lower";
registerMode(ID, "multi-entity");

type Q = {
  stack: UnifiedBuild[];
};

type A = { chain: number };

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  const universe = buildUniverse(input.data).filter((b) => b.totalPlays >= 3);
  if (universe.length < 5) {
    return { ok: false, reason: "Need ≥5 builds with ≥3 plays each." };
  }
  return { ok: true, minDataMet: true, question: { stack: shuffle(universe, input.rng) } };
}

function score(_q: Q, a: A): ScoreResult {
  return {
    raw: a.chain >= 8 ? 1 : a.chain / 8,
    xp: Math.min(40, a.chain * 4),
    outcome: a.chain >= 8 ? "correct" : a.chain > 0 ? "partial" : "wrong",
    note: `Chain: ${a.chain} build${a.chain === 1 ? "" : "s"}.`,
  };
}

function share(q: Q, a: A | null, _s: ScoreResult): ShareSummary {
  const chain = a?.chain ?? 0;
  const answer: string[] = [
    `Chain: ${chain} build${chain === 1 ? "" : "s"}.`,
  ];
  // Show the last few builds the user climbed through. The stack is
  // shuffled per round, so positions [0..chain] are the cards the
  // user actually saw face-up.
  const visited = q.stack.slice(0, Math.max(0, chain) + 1);
  const tail = visited.slice(-4);
  if (tail.length > 0) {
    answer.push("Recent rungs:");
    for (const b of tail) {
      answer.push(`• ${b.name} · ${pct1(b.winRate)} (${b.totalPlays}p)`);
    }
  }
  return {
    question: "Higher-or-lower chain on the matchup-WR ladder.",
    answer,
  };
}

export const higherOrLower: Mode<Q, A> = {
  id: ID,
  kind: "game",
  category: "builds",
  difficulty: "easy",
  ttp: "fast",
  depthTag: "multi-entity",
  title: "Higher or Lower",
  blurb: "Card stack of your builds. Guess if the next WR is higher, lower, or equal.",
  generate,
  score,
  share,
  render: (ctx) => <Render ctx={ctx} />,
};

function Render({
  ctx,
}: {
  ctx: Parameters<Mode<Q, A>["render"]>[0];
}) {
  const { recordPlay } = useArcadeState();
  const stack = ctx.question.stack;
  const [pos, setPos] = useState(0);
  const [lives, setLives] = useState(3);
  const [chain, setChain] = useState(0);
  const [feedback, setFeedback] = useState<{
    direction: "higher" | "lower" | "equal";
    correct: boolean;
  } | null>(null);

  const cur = stack[pos];
  const next = stack[pos + 1];

  const guess = (g: "higher" | "lower" | "equal") => {
    if (!next || lives <= 0) return;
    const a = cur.winRate;
    const b = next.winRate;
    const truth: "higher" | "lower" | "equal" =
      Math.abs(a - b) < 0.001 ? "equal" : b > a ? "higher" : "lower";
    const ok = g === truth;
    setFeedback({ direction: g, correct: ok });
    if (ok) {
      const newChain = chain + 1;
      setChain(newChain);
      setPos(pos + 1);
      // bestRun = chain length so personal-best persists.
      recordPlay({
        modeId: ID,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        xp: 4,
        raw: 1,
        correct: true,
        bestRun: newChain,
      });
    } else {
      const remaining = lives - 1;
      setLives(remaining);
      if (remaining <= 0) {
        ctx.onAnswer({ chain });
      } else {
        setPos(pos + 1);
      }
    }
  };

  const cardSurface = useMemo(() => {
    return (currentBuild: UnifiedBuild, hide: boolean) => (
      <div
        className={[
          "flex h-full w-full flex-col items-center justify-center gap-2 rounded-xl border bg-bg-elevated p-4",
          hide ? "border-accent/30" : "border-border",
        ].join(" ")}
      >
        <Icon
          name={raceIconName(coerceRace(currentBuild.race))}
          kind="race"
          size={32}
          decorative
        />
        <div className="text-center text-body font-semibold text-text">
          {currentBuild.name}
        </div>
        {hide ? (
          <span className="rounded-full border border-accent/40 bg-accent/15 px-2 py-0.5 text-caption font-mono uppercase tracking-wider text-accent">
            ?
          </span>
        ) : (
          <span
            className="font-mono tabular-nums text-display"
            style={{ color: wrColor(currentBuild.winRate, 5) }}
          >
            {pct1(currentBuild.winRate)}
          </span>
        )}
        <span className="text-caption text-text-dim">
          {currentBuild.totalPlays} plays
        </span>
      </div>
    );
  }, []);

  if (lives <= 0) {
    return (
      <GameStage
        icon={IconFor(ID)}
        title={higherOrLower.title}
        depthLabel="Multi-entity ladder of WRs"
        hud={{ score: chain, lives: 0, hint: "Game over" }}
        body={
          <div className="space-y-2 text-center text-body text-text">
            <p>
              Final chain:{" "}
              <span className="font-mono tabular-nums text-success">{chain}</span>
            </p>
            <p className="text-caption text-text-muted">
              Tap retry on the QuickPlay tile for another run.
            </p>
          </div>
        }
      />
    );
  }

  return (
    <GameStage
      icon={IconFor(ID)}
      title={higherOrLower.title}
      depthLabel="Multi-entity ladder of WRs"
      hud={{
        score: chain,
        lives,
        hint: feedback ? (feedback.correct ? "Nice! Keep going." : "Wrong. Try again.") : undefined,
      }}
      isDaily={ctx.isDaily}
      body={
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="aspect-[2/3]">{cardSurface(cur, false)}</div>
            <div className="aspect-[2/3]">{next ? cardSurface(next, true) : null}</div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(["higher", "equal", "lower"] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => guess(g)}
                disabled={!next}
                className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-border bg-bg-surface text-caption font-semibold uppercase tracking-wider text-text hover:bg-bg-elevated disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {g}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 text-caption text-text-muted">
            <Heart className="h-3 w-3 text-warning" aria-hidden />
            {Array.from({ length: lives }).map((_, i) => (
              <span key={i} className="text-warning">
                ♥
              </span>
            ))}
          </div>
        </div>
      }
    />
  );
}
