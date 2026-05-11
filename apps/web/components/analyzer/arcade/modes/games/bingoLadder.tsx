"use client";

import { useEffect, useMemo } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall } from "@/lib/clientApi";
import { GameStage } from "../../shells/GameStage";
import { IconFor } from "../../icons";
import { pickN, registerMode, weekKey } from "../../ArcadeEngine";
import { useArcadeState } from "../../hooks/useArcadeState";
import type {
  BingoCell,
  BingoState,
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
} from "../../types";

const ID = "bingo-ladder";
registerMode(ID, "forward");

type Q = {
  weekKey: string;
  cells: BingoCell[];
};

type A = { rerolled: boolean };

const REROLL_COST = 25;

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  const wk = weekKey(new Date(), input.tz);
  // Determine eligible races: ones the user actually played in the
  // last 30 days.
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const racesPlayed = new Set<string>();
  for (const g of input.data.games) {
    const t = new Date(g.date).getTime();
    if (Number.isFinite(t) && t < cutoff) continue;
    const r = String(g.myRace || "").charAt(0).toUpperCase();
    if (r === "P" || r === "T" || r === "Z") racesPlayed.add(r);
  }
  if (input.data.mapPool.length === 0 || racesPlayed.size === 0) {
    return {
      ok: false,
      reason: "Need recent games + a current ladder map pool to generate a card.",
    };
  }
  const cells = buildCard(input, wk, racesPlayed);
  return { ok: true, minDataMet: true, question: { weekKey: wk, cells } };
}

/** Card builder. 25 cells; index 12 (center) is the free space. */
function buildCard(
  input: GenerateInput,
  wk: string,
  racesPlayed: Set<string>,
): BingoCell[] {
  const racePool = Array.from(racesPlayed);
  const candidates: Array<Omit<BingoCell, "id" | "ticked">> = [];
  // Map-bound objectives — drawn exclusively from current map pool.
  for (const m of input.data.mapPool) {
    candidates.push({
      predicate: "win_on_map",
      params: { map: m },
      label: `Win on ${m}`,
    });
  }
  // Race-bound (as) objectives — drawn from races the user actually played in 30d.
  for (const r of racePool) {
    candidates.push({
      predicate: "win_as_race",
      params: { race: r },
      label: `Win as ${fullRace(r)}`,
    });
  }
  // Race-bound (vs) — versus all three races (data-driven, not user-bound).
  for (const r of ["P", "T", "Z"]) {
    candidates.push({
      predicate: "win_vs_race",
      params: { race: r },
      label: `Win vs ${fullRace(r)}`,
    });
  }
  // MMR-bound objective.
  candidates.push({
    predicate: "win_vs_higher_mmr",
    params: { diff: 100 },
    label: "Beat a +100 MMR opponent",
  });
  // Sequence objective.
  candidates.push({
    predicate: "three_in_a_row_win",
    params: {},
    label: "Win 3 games in a row",
  });
  // Length-based.
  candidates.push({
    predicate: "win_under_seconds",
    params: { maxSec: 360 },
    label: "Win in under 6 minutes",
  });
  candidates.push({
    predicate: "win_over_seconds",
    params: { minSec: 1500 },
    label: "Win a 25+ minute game",
  });
  // Macro-bound.
  candidates.push({
    predicate: "macro_above",
    params: { minScore: 70 },
    label: "Hit macro score 70+",
  });
  const seedVariant = input.rng;
  const picked = pickN(candidates, 24, seedVariant);
  const cells: BingoCell[] = picked.map((c, i) => ({
    id: `bingo-${wk}-${i}`,
    predicate: c.predicate,
    params: c.params,
    label: c.label,
    ticked: false,
  }));
  cells.splice(12, 0, {
    id: `bingo-${wk}-free`,
    predicate: "any_game",
    params: {},
    label: "Free space — play a game",
    ticked: false,
  });
  return cells.slice(0, 25);
}

function fullRace(letter: string): string {
  if (letter === "P") return "Protoss";
  if (letter === "T") return "Terran";
  if (letter === "Z") return "Zerg";
  return letter;
}

function score(): ScoreResult {
  // Engine awards XP per ticked cell on resolve, not at submit-time.
  return { raw: 0, xp: 0, outcome: "correct" };
}

export const bingoLadder: Mode<Q, A> = {
  id: ID,
  kind: "game",
  category: "forecast",
  difficulty: "medium",
  ttp: "long",
  depthTag: "forward",
  title: "Bingo: Ladder Edition",
  blurb: "5×5 of forward objectives. Resolved from your real next-7-day games.",
  generate,
  score,
  render: (ctx) => <Render ctx={ctx} />,
};

function Render({
  ctx,
}: {
  ctx: Parameters<Mode<Q, A>["render"]>[0];
}) {
  const { state, update, spendMinerals } = useArcadeState();
  const { getToken, isSignedIn } = useAuth();
  const card: BingoState | null = useMemo(() => {
    if (state.bingo && state.bingo.weekKey === ctx.question.weekKey) return state.bingo;
    return null;
  }, [state.bingo, ctx.question.weekKey]);

  // Initialise the persisted card if missing for this week.
  //
  // Idempotency note: this effect may fire BEFORE useArcadeState has
  // hydrated from the server (state.bingo is null by default), so the
  // mutator queue in useArcadeState may replay this on top of a real
  // hydrated card. The inner check on `prev.bingo` preserves the
  // saved card (including ticked cells) instead of seeding a fresh
  // one with everything unticked.
  useEffect(() => {
    if (card) return;
    update((prev) => {
      if (prev.bingo && prev.bingo.weekKey === ctx.question.weekKey) {
        return prev;
      }
      return {
        ...prev,
        bingo: {
          startedAt: new Date().toISOString(),
          weekKey: ctx.question.weekKey,
          rerolled: false,
          cells: ctx.question.cells,
        },
      };
    });
  }, [card, ctx.question, update]);

  // Re-resolve on every mount.
  useEffect(() => {
    if (!card || !isSignedIn) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await apiCall<{ resolved: Array<{ id: string; ticked: boolean; gameId?: string }> }>(
          getToken,
          "/v1/arcade/quests/resolve",
          {
            method: "POST",
            body: JSON.stringify({ card }),
          },
        );
        if (cancelled) return;
        const ticks = new Map(result.resolved.map((r) => [r.id, r]));
        update((prev) => {
          if (!prev.bingo || prev.bingo.weekKey !== card.weekKey) return prev;
          let changed = false;
          const next = prev.bingo.cells.map((c) => {
            const r = ticks.get(c.id);
            if (r && r.ticked && !c.ticked) {
              changed = true;
              return {
                ...c,
                ticked: true,
                tickedAt: new Date().toISOString(),
                gameId: r.gameId,
              };
            }
            return c;
          });
          if (!changed) return prev;
          return { ...prev, bingo: { ...prev.bingo, cells: next } };
        });
      } catch {
        // best-effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [card?.weekKey, getToken, isSignedIn, update]);

  const reroll = () => {
    if (!card || card.rerolled) return;
    if (!spendMinerals(REROLL_COST)) return;
    update((prev) => {
      if (!prev.bingo) return prev;
      return {
        ...prev,
        bingo: {
          ...prev.bingo,
          startedAt: new Date().toISOString(),
          rerolled: true,
          cells: ctx.question.cells.map((c) => ({ ...c, ticked: false })),
        },
      };
    });
  };

  if (!card) {
    return (
      <GameStage
        icon={IconFor(ID)}
        title={bingoLadder.title}
        depthLabel="Forward objectives, auto-resolved"
        hud={{ hint: "Generating card…" }}
        body={<p className="text-caption text-text-muted">Generating your weekly card…</p>}
      />
    );
  }
  const ticked = card.cells.filter((c) => c.ticked).length;
  const total = card.cells.length;

  return (
    <GameStage
      icon={IconFor(ID)}
      title={bingoLadder.title}
      depthLabel="Forward 7-day quest card"
      hud={{
        score: `${ticked}/${total}`,
        hint: card.rerolled
          ? "Reroll already used this week"
          : `Reroll: ${REROLL_COST} minerals`,
      }}
      isDaily={ctx.isDaily}
      body={
        <div
          role="grid"
          aria-label="Bingo card"
          className="grid grid-cols-5 gap-1.5 text-center text-[11px]"
        >
          {card.cells.map((c, i) => (
            <div
              role="gridcell"
              key={c.id}
              aria-label={c.label}
              className={[
                "flex aspect-square min-h-[48px] flex-col items-center justify-center rounded border px-1 py-1.5",
                c.ticked
                  ? "border-success bg-success/15 text-text"
                  : "border-border bg-bg-surface text-text-muted",
                i === 12 ? "border-accent/60 bg-accent/10" : "",
              ].join(" ")}
            >
              <span className="leading-tight">{c.label}</span>
            </div>
          ))}
        </div>
      }
      primary={
        <button
          type="button"
          onClick={reroll}
          disabled={card.rerolled || (state.minerals < REROLL_COST)}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-bg-surface px-3 text-caption font-semibold text-text hover:bg-bg-elevated disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {card.rerolled ? "Rerolled" : `Reroll (${REROLL_COST} 💎)`}
        </button>
      }
    />
  );
}
