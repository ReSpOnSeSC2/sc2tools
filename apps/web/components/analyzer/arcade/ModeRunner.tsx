"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useFilters } from "@/lib/filterContext";
import { Card, EmptyState } from "@/components/ui/Card";
import { useDailySeed } from "./hooks/useDailySeed";
import { useArcadeData } from "./hooks/useArcadeData";
import { useArcadeState } from "./hooks/useArcadeState";
import type {
  ArcadeDataset,
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
} from "./types";
import type { AnyMode } from "./modes";
import { mulberry32 } from "./ArcadeEngine";
import { shareCard } from "./ShareCard";
import { buildleEmoji } from "./modes/games/buildle";

/**
 * ModeRunner — one shared host that:
 *
 *   1. fetches the ArcadeDataset (once for the page) via useArcadeData,
 *   2. invokes mode.generate(input) and caches the result,
 *   3. renders mode.render(ctx) inside its shell,
 *   4. on answer, calls mode.score and persists XP/streak/record.
 *
 * The host never reaches into mode internals; modes only see the
 * RenderContext and a shared dataset. Quizzes get a one-shot reveal;
 * games get persistent state and may call onAnswer multiple times.
 */
export function ModeRunner({
  mode,
  isDaily,
  onPlayedFresh,
}: {
  mode: AnyMode;
  isDaily: boolean;
  /** Called the first time the user answers in this mount; surfaces use this to advance Today's Daily Drop. */
  onPlayedFresh?: () => void;
}) {
  const seed = useDailySeed();
  const { data, loading, error } = useArcadeData();
  const { recordPlay, earnBadge, state } = useArcadeState();
  // Filters are intentionally ignored for daily content; QuickPlay
  // honors them only on cross-axis modes (TT&L) where they make sense.
  const { filters } = useFilters();
  const [round, setRound] = useState(0);
  const [question, setQuestion] = useState<GenerateResult<unknown> | null>(null);
  const [answered, setAnswered] = useState<unknown>(null);
  const [scoreResult, setScoreResult] = useState<ScoreResult | null>(null);

  const filteredData = useMemo<ArcadeDataset | null>(() => {
    if (!data) return null;
    if (mode.depthTag !== "cross-axis" || isDaily) return data;
    // Cross-axis modes inherit the analyzer FilterBar.
    return applyFilters(data, filters);
  }, [data, filters, isDaily, mode.depthTag]);

  useEffect(() => {
    if (!filteredData) return;
    let cancelled = false;
    const rng = isDaily
      ? seed.rng
      : mulberry32(Math.floor(Math.random() * 0xffffffff));
    const input: GenerateInput = {
      rng,
      daySeed: isDaily ? seed.day : "",
      tz: seed.tz,
      data: filteredData,
    };
    setAnswered(null);
    setScoreResult(null);
    Promise.resolve(mode.generate(input))
      .then((q) => {
        if (cancelled) return;
        setQuestion(q);
      })
      .catch(() => {
        if (cancelled) return;
        setQuestion({ ok: false, reason: "Couldn't build this round." });
      });
    return () => {
      cancelled = true;
    };
  }, [filteredData, isDaily, mode, round, seed.day, seed.rng, seed.tz]);

  const handleAnswer = useCallback(
    (a: unknown) => {
      if (!question || !question.ok) return;
      const result = mode.score(question.question, a);
      setAnswered(a);
      setScoreResult(result);
      const fresh = answered === null;
      if (fresh && (mode.kind === "quiz" || (mode.kind === "game" && result.outcome === "correct"))) {
        recordPlay({
          modeId: mode.id,
          tz: seed.tz,
          xp: result.xp,
          raw: result.raw,
          correct: result.outcome === "correct",
        });
        onPlayedFresh?.();
        // Mode-specific badge pickers (kept simple — perfect-day badges
        // require external streak math beyond the scope of one round).
        if (mode.id === "buildle" && result.outcome === "correct") {
          // Resolve via state read inside mutator; recordPlay already bumped XP.
          // Buildle Brain: solve in ≤3 guesses (state.buildleByDay carries history).
          const today = state.buildleByDay[seed.day];
          if (today && today.guesses.length <= 3 && today.solved) {
            earnBadge("buildle-brain");
          }
        }
      }
    },
    [
      question,
      mode,
      answered,
      recordPlay,
      seed.tz,
      seed.day,
      onPlayedFresh,
      state.buildleByDay,
      earnBadge,
    ],
  );

  const handleNext = useCallback(() => {
    if (isDaily) return; // Daily content is once per day.
    setRound((r) => r + 1);
  }, [isDaily]);

  const handleShare = useCallback(async () => {
    if (!question || !question.ok) return;
    if (mode.id === "buildle") {
      // Wordle-style emoji grid, copied to the clipboard.
      const today = state.buildleByDay[seed.day];
      if (!today) return;
      const grid = buildleEmoji(
        today.guesses,
        today.buildName,
        // Re-derive features from the question's known truth.
        (question.question as { features: import("./modes/games/buildle").BuildleFeatures }).features,
        (question.question as { candidates: string[] }).candidates,
      );
      try {
        await navigator.clipboard.writeText(grid);
      } catch {
        // ignore
      }
      return;
    }
    await shareCard({
      title: mode.title,
      lines: scoreResult?.note ? [scoreResult.note] : ["I just played in Arcade."],
      tag: `Arcade · ${isDaily ? "Daily" : "Quick Play"}`,
      tone: scoreResult?.outcome === "correct" ? "wins" : "neutral",
    });
  }, [question, mode, scoreResult, isDaily, seed.day, state.buildleByDay]);

  if (loading) {
    return (
      <Card>
        <EmptyState title="Loading…" sub="Pulling your data." />
      </Card>
    );
  }
  if (error || !filteredData) {
    return (
      <Card>
        <EmptyState title="Couldn't load" sub={error || "No data available."} />
      </Card>
    );
  }
  if (!question) {
    return (
      <Card>
        <EmptyState title="Building round…" sub="Generating from your real data." />
      </Card>
    );
  }
  if (!question.ok) {
    return (
      <Card>
        <EmptyState title="Not enough data yet" sub={question.reason} />
        {question.cta ? (
          <div className="text-center">
            <a
              href={question.cta.href}
              className="inline-flex min-h-[44px] items-center rounded-md bg-accent px-4 text-caption font-semibold uppercase tracking-wider text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {question.cta.label}
            </a>
          </div>
        ) : null}
      </Card>
    );
  }

  const renderProps = {
    question: question.question,
    answer: answered,
    onAnswer: handleAnswer,
    score: scoreResult,
    revealed: scoreResult !== null,
    isDaily,
  };
  // The mode owns the share/next chrome inside its render — but for
  // QuizCard-based modes we tunnel onShare/onNext through props by
  // wiring them on the rendered shell via cloneElement isn't worth it.
  // Instead we present a lightweight "next" affordance under the round
  // when in QuickPlay.
  return (
    <div className="space-y-3">
      {(mode.render as Mode<unknown, unknown, ScoreResult>["render"])(renderProps)}
      {scoreResult && !isDaily && mode.kind === "quiz" ? (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleNext}
            className="inline-flex min-h-[44px] items-center rounded-md bg-accent px-4 text-caption font-semibold uppercase tracking-wider text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Next round →
          </button>
        </div>
      ) : null}
      {scoreResult ? (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleShare}
            className="inline-flex min-h-[40px] items-center rounded-md border border-border bg-bg-surface px-3 text-caption text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Share
          </button>
        </div>
      ) : null}
    </div>
  );
}

function applyFilters(
  data: ArcadeDataset,
  filters: ReturnType<typeof useFilters>["filters"],
): ArcadeDataset {
  if (!filters) return data;
  // Date / race filters affect the games slice.
  const since = filters.since ? new Date(filters.since).getTime() : -Infinity;
  const until = filters.until ? new Date(filters.until).getTime() : Infinity;
  const games = data.games.filter((g) => {
    const t = new Date(g.date).getTime();
    if (!Number.isFinite(t) || t < since || t > until) return false;
    if (
      filters.race &&
      filters.race !== "Any" &&
      String(g.myRace || "").charAt(0).toUpperCase() !== filters.race.charAt(0).toUpperCase()
    ) {
      return false;
    }
    if (
      filters.opp_race &&
      filters.opp_race !== "Any" &&
      String(g.oppRace || "").charAt(0).toUpperCase() !== filters.opp_race.charAt(0).toUpperCase()
    ) {
      return false;
    }
    if (filters.map && g.map !== filters.map) return false;
    if (filters.build && g.myBuild !== filters.build) return false;
    if (filters.opp_strategy && g.opp_strategy !== filters.opp_strategy) return false;
    return true;
  });
  return { ...data, games };
}
