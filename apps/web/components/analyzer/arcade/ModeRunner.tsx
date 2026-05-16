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
  ShareSummary,
} from "./types";
import type { AnyMode } from "./modes";
import { mulberry32 } from "./ArcadeEngine";
import { shareCard } from "./ShareCard";
import { DailyEmptyState } from "./surfaces/DailyEmptyState";

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
  forceMode = false,
}: {
  mode: AnyMode;
  isDaily: boolean;
  /** Called the first time the user answers in this mount; surfaces use this to advance Today's Daily Drop. */
  onPlayedFresh?: () => void;
  /**
   * When true (paired with `isDaily`), the upstream picker has already
   * verified that `mode.generate(input)` will return ok:true today.
   * If it nevertheless returns ok:false we render the unified
   * DailyEmptyState instead of leaking the per-mode reason. Other
   * call sites (QuickPlay, Collection) leave this false to preserve
   * the existing per-mode "Not enough data yet" UI.
   */
  forceMode?: boolean;
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
      // Record every fresh attempt across quizzes AND games — including
      // wrong/partial outcomes. Previously games only recorded on
      // outcome==="correct", which left attempts/correct counters at 0
      // for the entire "My Stats → Per-mode records" surface for any
      // user who ever lost a round of Buildle/Bingo/Stock Market. The
      // attempts counter must climb on every fresh submission so the
      // surface shows real activity, not just perfect runs.
      if (fresh) {
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
          // Buildle Brain: 5 correct Daily case files in a row, counting
          // today. The current day's record hasn't flushed yet, so
          // we treat today as correct (we're in this branch) and walk
          // the prior 4 calendar days in state.buildleByDay.
          let consecutive = 1;
          const todayDate = new Date(`${seed.day}T00:00:00Z`);
          if (!Number.isNaN(todayDate.getTime())) {
            for (let i = 1; i < 5; i++) {
              const d = new Date(todayDate);
              d.setUTCDate(d.getUTCDate() - i);
              const key = d.toISOString().slice(0, 10);
              if (state.buildleByDay[key]?.correct) consecutive += 1;
              else break;
            }
          }
          if (consecutive >= 5) earnBadge("buildle-brain");
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
    const summary = buildShareSummary(mode, question.question, answered, scoreResult);
    await shareCard({
      title: mode.title,
      question: summary.question,
      lines: summary.answer,
      outcome: scoreResult?.outcome,
      tag: `Arcade · ${isDaily ? "Daily" : "Quick Play"}`,
    });
  }, [question, mode, scoreResult, answered, isDaily]);

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
    if (forceMode && isDaily) {
      // Safety net — the upstream daily picker probed every mode with this
      // same dataset + seed, so a non-ok here means the gate and the probe
      // disagree (e.g. a race condition between probe + render or a mode
      // bug). Show the unified warm-up card instead of leaking the
      // per-mode reason as the day's headline.
      // eslint-disable-next-line no-console
      console.warn("[arcade] eligibility/generate mismatch", mode.id);
      return <DailyEmptyState kind={mode.kind === "quiz" ? "quiz" : "game"} />;
    }
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

/**
 * Build the plain-text share payload for the round. Prefers the mode's
 * own `share()` implementation (which can include detail tables, the
 * full reveal etc.) and falls back to `mode.blurb` + `score.note` so
 * every mode at least surfaces the question framing — not just the
 * mode title — alongside the one-line outcome.
 */
function buildShareSummary(
  mode: AnyMode,
  question: unknown,
  answer: unknown,
  score: ScoreResult | null,
): ShareSummary {
  // The Mode<Q, A, S> generic parameters vary by mode; the registry
  // narrows them away to AnyMode here, so the cast is a one-time
  // contract assertion — the runtime values come from the same mode.
  type ModeShareFn = (q: unknown, a: unknown, s: ScoreResult) => ShareSummary;
  const shareFn = (mode as { share?: ModeShareFn }).share;
  if (shareFn && score) {
    try {
      const out = shareFn(question, answer, score);
      if (out && typeof out.question === "string" && Array.isArray(out.answer)) {
        return out;
      }
    } catch {
      // fall through to the default summary
    }
  }
  const fallback: string[] = [];
  if (score?.note) fallback.push(score.note);
  else if (score?.outcome === "correct") fallback.push("Nailed it.");
  else if (score?.outcome === "wrong") fallback.push("Missed this one.");
  else fallback.push("I just played in Arcade.");
  return { question: mode.blurb, answer: fallback };
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
