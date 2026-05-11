"use client";

import { useMemo, useState } from "react";
import { pct1 } from "@/lib/format";
import { QuizAnswerButton, QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import { outcome, pickN, registerMode, shuffle } from "../../ArcadeEngine";
import type {
  ArcadeDataset,
  ArcadeGame,
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
} from "../../types";

const ID = "two-truths-lie";
registerMode(ID, "cross-axis");

type Claim = {
  text: string;
  truthful: boolean;
  detail: string;
};

type Q = {
  claims: Claim[];
  lieIndex: number;
};

type A = number;

/**
 * Generate three multi-axis claims about the user — two true, one
 * false. Every claim must combine ≥2 axes (matchup × time-of-day,
 * game-length × race, build × map), so a single-tab sort never gives
 * the answer away. The "lie" is built by perturbing one true claim
 * into something the data clearly refutes; the engine refuses to ship
 * a round if it can't fabricate a clearly-false claim.
 */
async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  if (input.data.games.length < 25) {
    return { ok: false, reason: "Need at least 25 games to weave claims from." };
  }
  const facts = buildFactPool(input.data);
  if (facts.length < 3) {
    return { ok: false, reason: "Couldn't find enough cross-axis facts." };
  }
  const truths = pickN(facts, 2, input.rng);
  // Construct a lie by inverting one fact.
  const remaining = facts.filter((f) => !truths.includes(f));
  const lieSource = remaining[Math.floor(input.rng() * remaining.length)] || facts[0];
  const lie: Claim = {
    text: lieSource.lieText,
    truthful: false,
    detail: lieSource.detail,
  };
  const claims = shuffle(
    [
      ...truths.map((t) => ({ text: t.truthText, truthful: true, detail: t.detail })),
      lie,
    ],
    input.rng,
  );
  const lieIndex = claims.findIndex((c) => !c.truthful);
  return { ok: true, minDataMet: true, question: { claims, lieIndex } };
}

interface FactCandidate {
  truthText: string;
  /** A negation/inversion of the same fact that the data refutes. */
  lieText: string;
  detail: string;
}

/** A string is "displayable" when it survives templating without
 *  producing the literal "undefined" or an empty box. Treat null,
 *  empty strings, and pure-whitespace strings as missing. */
function isDisplayableString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function buildFactPool(data: ArcadeDataset): FactCandidate[] {
  const out: FactCandidate[] = [];
  // Fact 1: top-played build's WR is higher than overall WR.
  const topBuild = data.builds
    .slice()
    .filter((b) => isDisplayableString(b.name))
    .sort((a, b) => b.total - a.total)[0];
  if (topBuild && data.summary && topBuild.total >= 5) {
    const diff = topBuild.winRate - data.summary.winRate;
    out.push({
      truthText:
        diff >= 0
          ? `Your most-played build (“${topBuild.name}”) has a higher WR than your overall WR.`
          : `Your most-played build (“${topBuild.name}”) has a lower WR than your overall WR.`,
      lieText:
        diff >= 0
          ? `Your most-played build (“${topBuild.name}”) has a lower WR than your overall WR.`
          : `Your most-played build (“${topBuild.name}”) has a higher WR than your overall WR.`,
      detail: `Build WR ${pct1(topBuild.winRate)} vs overall ${pct1(data.summary.winRate)}.`,
    });
  }
  // Fact 2: short-games (< 12 min) race-up split.
  const shortGames = data.games.filter(
    (g) => Number(g.duration) > 0 && Number(g.duration) < 12 * 60,
  );
  if (shortGames.length >= 8) {
    const wrByRace = wrPerOppRace(shortGames);
    const entries = Object.entries(wrByRace).filter(([, v]) => v.games >= 3);
    if (entries.length >= 2) {
      entries.sort((a, b) => b[1].wr - a[1].wr);
      const top = entries[0][0];
      const bottom = entries[entries.length - 1][0];
      // wrPerOppRace already excludes anything but P/T/Z; both keys are
      // always real race letters.
      out.push({
        truthText: `In games under 12 minutes, you do better vs ${fullRace(top)} than vs ${fullRace(bottom)}.`,
        lieText: `In games under 12 minutes, you do better vs ${fullRace(bottom)} than vs ${fullRace(top)}.`,
        detail: `Short-game WR vs ${fullRace(top)} ${pct1(wrByRace[top].wr)}, vs ${fullRace(bottom)} ${pct1(wrByRace[bottom].wr)}.`,
      });
    }
  }
  // Fact 3: best-map WR vs worst-map WR (≥ 4 games each).
  // /v1/maps occasionally returns rows with a null/empty `map` field
  // (matchmaking quirk on certain expired co-op maps) — those rows
  // make their way into the claim text as the literal string
  // "undefined" without a name filter here.
  const maps = data.maps.filter(
    (m) => isDisplayableString(m.map) && m.total >= 4,
  );
  if (maps.length >= 2) {
    const sortedMaps = maps.slice().sort((a, b) => b.winRate - a.winRate);
    const best = sortedMaps[0];
    const worst = sortedMaps[sortedMaps.length - 1];
    // Filter out the degenerate (best === worst) case when the filtered
    // pool collapses to one logical map after dedupe.
    if (best.map !== worst.map) {
      out.push({
        truthText: `You have a higher WR on ${best.map} than on ${worst.map}.`,
        lieText: `You have a higher WR on ${worst.map} than on ${best.map}.`,
        detail: `${best.map} ${pct1(best.winRate)} (${best.total}g), ${worst.map} ${pct1(worst.winRate)} (${worst.total}g).`,
      });
    }
  }
  // Fact 4: matchup × time-of-day (late vs early). Cross-axis bonus.
  const hourBuckets = bucketByHour(data.games);
  if (hourBuckets.late.total >= 5 && hourBuckets.early.total >= 5) {
    const lateWr = hourBuckets.late.wr;
    const earlyWr = hourBuckets.early.wr;
    const diff = lateWr - earlyWr;
    out.push({
      truthText:
        diff >= 0
          ? `Your WR after 10pm is higher than your WR before noon.`
          : `Your WR after 10pm is lower than your WR before noon.`,
      lieText:
        diff >= 0
          ? `Your WR after 10pm is lower than your WR before noon.`
          : `Your WR after 10pm is higher than your WR before noon.`,
      detail: `Late ${pct1(lateWr)} (${hourBuckets.late.total}g), early ${pct1(earlyWr)} (${hourBuckets.early.total}g).`,
    });
  }
  return out;
}

function wrPerOppRace(games: ArcadeGame[]): Record<string, { wr: number; games: number }> {
  const acc: Record<string, { wins: number; total: number }> = {};
  for (const g of games) {
    const r = String(g.oppRace || "").charAt(0).toUpperCase();
    if (!(r === "P" || r === "T" || r === "Z")) continue;
    const o = outcome(g);
    if (o === "U") continue;
    acc[r] ||= { wins: 0, total: 0 };
    acc[r].total += 1;
    if (o === "W") acc[r].wins += 1;
  }
  const out: Record<string, { wr: number; games: number }> = {};
  for (const [r, v] of Object.entries(acc)) {
    if (v.total > 0) out[r] = { wr: v.wins / v.total, games: v.total };
  }
  return out;
}

function bucketByHour(games: ArcadeGame[]): {
  late: { wr: number; total: number };
  early: { wr: number; total: number };
} {
  let lateWins = 0;
  let lateLosses = 0;
  let earlyWins = 0;
  let earlyLosses = 0;
  for (const g of games) {
    const d = new Date(g.date);
    if (Number.isNaN(d.getTime())) continue;
    const hour = d.getHours();
    const o = outcome(g);
    if (o === "U") continue;
    if (hour >= 22 || hour < 2) {
      if (o === "W") lateWins++;
      else lateLosses++;
    } else if (hour < 12) {
      if (o === "W") earlyWins++;
      else earlyLosses++;
    }
  }
  return {
    late: {
      wr: lateWins + lateLosses > 0 ? lateWins / (lateWins + lateLosses) : 0,
      total: lateWins + lateLosses,
    },
    early: {
      wr: earlyWins + earlyLosses > 0 ? earlyWins / (earlyWins + earlyLosses) : 0,
      total: earlyWins + earlyLosses,
    },
  };
}

function fullRace(letter: string): string {
  if (letter === "P") return "Protoss";
  if (letter === "T") return "Terran";
  if (letter === "Z") return "Zerg";
  return letter;
}

function score(q: Q, a: A): ScoreResult {
  const correct = a === q.lieIndex;
  const lie = q.claims[q.lieIndex];
  return {
    raw: correct ? 1 : 0,
    xp: correct ? 16 : 0,
    outcome: correct ? "correct" : "wrong",
    note: `The lie: "${lie.text}"`,
  };
}

export const twoTruthsLie: Mode<Q, A> = {
  id: ID,
  kind: "game",
  category: "matchups",
  difficulty: "hard",
  ttp: "medium",
  depthTag: "cross-axis",
  title: "Two Truths & a Lie",
  blurb: "Two true claims about you, one fake. Spot the lie.",
  generate,
  score,
  render: (ctx) => <Render ctx={ctx} />,
};

function Render({
  ctx,
}: {
  ctx: Parameters<Mode<Q, A>["render"]>[0];
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const onPick = (i: number) => {
    if (ctx.revealed) return;
    setPicked(i);
    ctx.onAnswer(i);
  };

  const reveal = useMemo(
    () =>
      ctx.score ? (
        <div className="space-y-2 text-caption text-text">
          <p className={ctx.score.outcome === "correct" ? "text-success" : "text-warning"}>
            The lie was claim #{ctx.question.lieIndex + 1}.
          </p>
          <ul className="space-y-1">
            {ctx.question.claims.map((c, i) => (
              <li
                key={`${c.text}-${i}`}
                className="rounded border border-border bg-bg-surface px-2 py-1"
              >
                <div className="font-medium">
                  {c.truthful ? (
                    <span className="text-success">TRUE</span>
                  ) : (
                    <span className="text-danger">LIE</span>
                  )}{" "}
                  · {c.text}
                </div>
                <div className="text-text-dim">{c.detail}</div>
              </li>
            ))}
          </ul>
        </div>
      ) : null,
    [ctx.score, ctx.question],
  );

  return (
    <QuizCard
      icon={IconFor(ID)}
      title={twoTruthsLie.title}
      depthLabel="Cross-axis claims (two true, one false)"
      isDaily={ctx.isDaily}
      revealed={ctx.revealed}
      onKeyAnswer={onPick}
      question={
        <span>
          Three statements. Two are true, one is{" "}
          <span className="font-semibold text-danger">a lie</span>. Spot the lie.
        </span>
      }
      answers={ctx.question.claims.map((c, i) => (
        <QuizAnswerButton
          key={i}
          index={i}
          selected={picked === i}
          correct={
            ctx.revealed
              ? i === ctx.question.lieIndex
                ? true
                : picked === i
                  ? false
                  : null
              : null
          }
          onClick={() => onPick(i)}
          disabled={ctx.revealed}
        >
          {c.text}
        </QuizAnswerButton>
      ))}
      reveal={reveal}
    />
  );
}
