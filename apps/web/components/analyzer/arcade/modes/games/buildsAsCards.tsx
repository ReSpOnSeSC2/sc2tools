"use client";

import { useEffect, useMemo } from "react";
import { Icon } from "@/components/ui/Icon";
import { coerceRace, raceIconName } from "@/lib/race";
import { GameStage } from "../../shells/GameStage";
import { IconFor } from "../../icons";
import { registerMode } from "../../ArcadeEngine";
import {
  attackForBuild,
  buildUniverse,
  defenseFor,
  isFoil,
  rarityForPlays,
} from "../../sessions";
import { useArcadeState } from "../../hooks/useArcadeState";
import { CardBinder } from "../../collection/CardBinder";
import type {
  ArcadeDataset,
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
  ShareSummary,
} from "../../types";

const ID = "builds-as-cards";
registerMode(ID, "generative");

type Card = {
  slug: string;
  name: string;
  race?: string;
  rarity: "bronze" | "silver" | "gold" | "mythic";
  attack: number;
  defense: number;
  foil: boolean;
  plays: number;
};

type Q = {
  cards: Card[];
};

type A = { browsed: true };

/**
 * The binder seeds its universe from BUILD_DEFINITIONS, so
 * `universe.length === 0` is never true on an empty dataset — the
 * 100+ catalog stubs alone would qualify the mode as eligible.
 * `hasAnyRealCards` is what the daily-picker probe (and the
 * empty-state branch in `generate`) actually want: it returns true
 * only when the user has at least one row that came from their own
 * play history, an authored custom build, or a community-published
 * build, i.e. some real data to anchor the binder against.
 */
function hasAnyRealCards(data: ArcadeDataset): boolean {
  return (
    data.builds.length > 0 ||
    data.customBuilds.length > 0 ||
    data.communityBuilds.length > 0
  );
}

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  // Pull from the same universe Stock Market does — own + community +
  // custom + the bundled BUILD_DEFINITIONS catalog — so the binder
  // surfaces every analyzer-detectable strategy across every race and
  // matchup, not just the ones the user has personally engaged with.
  // Catalog stubs with zero plays render as bronze rarity with
  // attack=0 until the user plays them. The completion percentage is
  // *expected* to be well below 100% — that's the point of seeing the
  // full meta in one place — and the count is computed off the live
  // `c.plays > 0` field below so it always matches the on-screen
  // "Not played yet" rendering.
  const universe = buildUniverse(input.data, { includeCatalog: true });
  // The bundled catalog is non-empty, so an empty universe is
  // unreachable in practice. The real signal we want for "no round
  // available today" is whether the user has at least one own /
  // community / custom row — otherwise the daily picker would queue
  // Builds-as-Cards for a brand-new account that only has the 100+
  // catalog stubs to look at.
  if (universe.length === 0 || !hasAnyRealCards(input.data)) {
    return {
      ok: false,
      reason: "Play a few games and we'll start unlocking your card binder.",
    };
  }
  const cards: Card[] = universe.map((b) => ({
    slug: b.id,
    name: b.name,
    race: b.race,
    rarity: rarityForPlays(b.totalPlays),
    attack: attackForBuild(b),
    defense: defenseFor(b.name, input.data),
    foil: isFoil(b.name, input.data),
    plays: b.totalPlays,
  }));
  return { ok: true, minDataMet: true, question: { cards } };
}

function score(q: Q): ScoreResult {
  return {
    raw: 1,
    xp: 0,
    outcome: "correct",
    note: `Binder: ${q.cards.length} build card${q.cards.length === 1 ? "" : "s"}.`,
  };
}

function share(q: Q, _a: A | null, _s: ScoreResult): ShareSummary {
  const total = q.cards.length;
  const played = q.cards.filter((c) => c.plays > 0);
  const answer: string[] = [
    `Binder: ${total} build card${total === 1 ? "" : "s"}.`,
    `Played: ${played.length} · Locked: ${total - played.length}`,
  ];
  // List a few of the user's most-played cards so the reader sees
  // which builds anchor the binder — mirrors the per-card stats the
  // CardBinder face shows (ATK / DEF / plays).
  const top = played
    .slice()
    .sort((a, b) => b.plays - a.plays)
    .slice(0, 4);
  if (top.length > 0) {
    answer.push("Top cards:");
    for (const c of top) {
      answer.push(`• ${c.name} · ${c.rarity}${c.foil ? " foil" : ""} · ${c.plays}p`);
    }
  }
  return {
    question: "Build binder — collected cards from your real games.",
    answer,
  };
}

export const buildsAsCards: Mode<Q, A> = {
  id: ID,
  kind: "game",
  category: "collection",
  difficulty: "easy",
  ttp: "long",
  depthTag: "generative",
  title: "Builds as Cards",
  blurb: "Every build you've played becomes a collectible card. Foil at 10 wins.",
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
  const { unlockCard } = useArcadeState();
  const totals = useMemo(() => ctx.question.cards.length, [ctx.question.cards]);
  // Source of truth for "unlocked" is the card's own `plays` field —
  // i.e. whether /v1/builds returned a row for this build name. The
  // persisted `state.unlockedCards` dict used to drive this count, but
  // because it accumulates lifetime unlocks (never clears) it drifted
  // out of sync with the on-screen render (which keys "Not played yet"
  // off `c.plays === 0`). For heavy users that drift surfaced as a
  // score like 117/119 alongside a visibly-greater number of grayed-
  // out catalog stubs. Keeping the persisted dict as a write-only
  // audit log (so future features can ask "when did the user first
  // unlock this card?") but reading the live count off `plays` keeps
  // the HUD honest against what the binder grid is showing.
  const unlocked = useMemo(
    () => ctx.question.cards.filter((c) => c.plays > 0).length,
    [ctx.question.cards],
  );

  // Stamp first-unlock timestamps for played cards into the persisted
  // arcade state. This no longer drives the visible counter (see the
  // `unlocked` memo above) — it's purely an audit log so a future
  // achievement / badge surface can ask "when did the user first
  // collect <build>?" without re-scanning every game. Skips cards
  // already stamped so we don't churn the persistence layer.
  useEffect(() => {
    for (const c of ctx.question.cards) {
      if (c.plays > 0) unlockCard(c.slug);
    }
  }, [ctx.question.cards, unlockCard]);

  return (
    <GameStage
      icon={IconFor(ID)}
      title={buildsAsCards.title}
      depthLabel="Collection: derived rarity / attack / defense"
      hud={{
        score: `${unlocked}/${totals}`,
        hint:
          totals > 0
            ? `Completion ${Math.round((unlocked / totals) * 100)}%`
            : undefined,
      }}
      isDaily={ctx.isDaily}
      body={
        <div className="space-y-3">
          <p className="text-caption text-text-muted">
            ATK = win rate × 100. DEF = mean win length (minutes,
            clamped 1–60). Rarity tracks total plays: bronze 1–4,
            silver 5–14, gold 15–49, mythic 50+. Foil at ≥10 wins.
            Builds you haven&apos;t played yet appear locked.
          </p>
          <CardBinder
            cards={ctx.question.cards}
            renderCardFace={(c) => {
              const played = c.plays > 0;
              return (
                <span
                  className={[
                    "flex flex-col items-center gap-1.5",
                    played ? "" : "opacity-40 grayscale",
                  ].join(" ")}
                >
                  <Icon
                    name={raceIconName(coerceRace(c.race))}
                    kind="race"
                    size={28}
                    decorative
                  />
                  <span className="line-clamp-2 text-center text-caption font-medium text-text">
                    {c.name}
                  </span>
                  {played ? (
                    <span className="font-mono text-[10px] uppercase tracking-wider text-text-dim">
                      ATK {c.attack} · DEF {c.defense}
                    </span>
                  ) : (
                    <span className="font-mono text-[10px] uppercase tracking-wider text-text-dim">
                      Not played yet
                    </span>
                  )}
                </span>
              );
            }}
          />
        </div>
      }
    />
  );
}
