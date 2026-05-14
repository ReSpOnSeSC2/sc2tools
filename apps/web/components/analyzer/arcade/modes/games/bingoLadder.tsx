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
import { buildCandidates } from "./bingoLadder.candidates";

const ID = "bingo-ladder";
registerMode(ID, "forward");

type Q = {
  weekKey: string;
  cells: BingoCell[];
};

type A = { rerolled: boolean };

const REROLL_COST = 25;

/**
 * Predicates retired in past card-mix overhauls. A persisted card
 * containing any of these is treated as legacy and re-generated on
 * load, so users whose card was minted under the old schema
 * automatically get the new objective mix instead of waiting up to a
 * full ISO week for the Monday rollover. Resolver-side the predicates
 * still resolve (back-compat for read paths) but the generator no
 * longer mints fresh cells for them.
 */
const LEGACY_PREDICATES = new Set([
  // Per-map objectives (May-2026 overhaul). The user's ladder map pool
  // is a moving target, the strings render long ("Win on Whispers of
  // Gold"), and they crowded out more interesting objectives. The
  // analyzer's map-stats tab covers per-map breakdowns better than a
  // bingo cell ever could.
  "win_on_map",
  // Opponent-strategy substring objectives (May-2026 — second pass).
  // The agent's classifier doesn't emit a stable taxonomy for
  // opponent rushes / cheese / proxy / all-in. The cells looked
  // exciting but the resolver couldn't reliably decide whether a
  // given opponent strategy string matched "Cheese" vs "Early
  // Aggression" vs "Pool First". Replaced with bounded-duration
  // ranges (Win between 5-10 min, etc.) that are derivable from the
  // game row alone.
  "win_vs_strategy_contains",
  // APM objectives (May-2026 — third pass). Per-game APM ingestion
  // is inconsistent across replay paths: some rows ship an averaged
  // figure including the opponent's actions, others ship the
  // per-player number. A "Win with 250+ APM" cell ticked or didn't
  // based on which path produced the row, not on what the user
  // actually did. Macro-score cells stay (single deterministic
  // number derived from supply / build / inject timings).
  "win_apm_above",
]);

/**
 * Specific (predicate, paramKey) pairs retired even though the
 * predicate itself is still alive. Used historically to drop "Win
 * with an Expand opener" cells minted under the old card schema —
 * the agent's strategy classifier has no stable label for an "expand
 * opener" so the cell was effectively unwinnable. The list lives on
 * for future surgical retirements without having to retire a whole
 * predicate.
 */
const LEGACY_PARAM_KEYS: ReadonlyArray<[string, string]> = [
  ["win_build_contains", "expand"],
];

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
  if (racesPlayed.size === 0) {
    return {
      ok: false,
      reason: "Need recent games to generate a card.",
    };
  }
  const cells = buildCard(input, wk, racesPlayed);
  return { ok: true, minDataMet: true, question: { weekKey: wk, cells } };
}

/**
 * Build the 25-cell card. Pulls from the candidate factory in
 * bingoLadder.candidates.ts, shuffles with the input's seeded RNG,
 * takes 24, and splices in the center free-space cell. The candidate
 * list is already deduplicated by ``key`` so the shuffle can't
 * reintroduce a collision.
 */
function buildCard(
  input: GenerateInput,
  wk: string,
  racesPlayed: Set<string>,
): BingoCell[] {
  const candidates = buildCandidates(racesPlayed);
  const picked = pickN(candidates, 24, input.rng);
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

/**
 * Whether the saved card carries any predicate that the current
 * generator no longer mints. When true, the saved card is dropped and
 * the freshly-generated one (ctx.question.cells) replaces it on next
 * effect run. Without this, a user whose card was minted under the
 * pre-overhaul predicate set would stay stuck with retired cells
 * until the next ISO-week rollover.
 */
function isLegacyCard(state: BingoState | null): boolean {
  if (!state) return false;
  if (!Array.isArray(state.cells) || state.cells.length === 0) return false;
  return state.cells.some((c) => {
    if (LEGACY_PREDICATES.has(c.predicate)) return true;
    for (const [pred, paramSub] of LEGACY_PARAM_KEYS) {
      if (c.predicate !== pred) continue;
      const p = c.params || {};
      for (const v of Object.values(p)) {
        if (typeof v === "string" && v.toLowerCase().includes(paramSub)) {
          return true;
        }
      }
    }
    return false;
  });
}

function score(q: Q): ScoreResult {
  // Engine awards XP per ticked cell on resolve, not at submit-time.
  return {
    raw: 0,
    xp: 0,
    outcome: "correct",
    note: `Bingo card · Week ${q.weekKey}`,
  };
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

export const __test = {
  buildCard,
  isLegacyCard,
  LEGACY_PREDICATES,
  LEGACY_PARAM_KEYS,
};

function Render({
  ctx,
}: {
  ctx: Parameters<Mode<Q, A>["render"]>[0];
}) {
  const { state, update, spendMinerals } = useArcadeState();
  const { getToken, isSignedIn } = useAuth();
  const card: BingoState | null = useMemo(() => {
    if (!state.bingo) return null;
    if (state.bingo.weekKey !== ctx.question.weekKey) return null;
    // A card persisted under the pre-overhaul schema still claims the
    // current weekKey but references predicates the generator no longer
    // mints (and labels we no longer want shown). Treat as missing so
    // the seed-effect below replaces it with the fresh card.
    if (isLegacyCard(state.bingo)) return null;
    return state.bingo;
  }, [state.bingo, ctx.question.weekKey]);

  // Initialise the persisted card if missing for this week.
  //
  // Idempotency note: this effect may fire BEFORE useArcadeState has
  // hydrated from the server (state.bingo is null by default), so the
  // mutator queue in useArcadeState may replay this on top of a real
  // hydrated card. The inner check on `prev.bingo` preserves the
  // saved card (including ticked cells) instead of seeding a fresh
  // one with everything unticked — UNLESS the saved card is legacy,
  // in which case we replace it.
  useEffect(() => {
    if (card) return;
    update((prev) => {
      if (
        prev.bingo &&
        prev.bingo.weekKey === ctx.question.weekKey &&
        !isLegacyCard(prev.bingo)
      ) {
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
