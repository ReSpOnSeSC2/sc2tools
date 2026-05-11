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
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
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

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  // Pull from the same universe Stock Market does — own + community +
  // custom + the bundled BUILD_DEFINITIONS catalog — so the binder
  // surfaces every analyzer-detectable strategy, not just the ones the
  // user has personally engaged with. Catalog stubs with zero plays
  // render as bronze rarity with attack=0 until the user plays them.
  const universe = buildUniverse(input.data, { includeCatalog: true });
  if (universe.length === 0) {
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
  render: (ctx) => <Render ctx={ctx} />,
};

function Render({
  ctx,
}: {
  ctx: Parameters<Mode<Q, A>["render"]>[0];
}) {
  const { state, unlockCard } = useArcadeState();
  const totals = useMemo(() => ctx.question.cards.length, [ctx.question.cards]);
  const unlocked = useMemo(
    () => ctx.question.cards.filter((c) => state.unlockedCards[c.slug]).length,
    [ctx.question.cards, state.unlockedCards],
  );

  // Auto-unlock cards the user has actually played. Catalog stubs and
  // community/custom builds that the user has never run land in the
  // binder with plays=0 — those stay locked so the completion counter
  // ("X / total") reflects real engagement instead of jumping to 100%
  // the moment the binder opens. The unlock is single-pass; cards
  // already in state are no-ops.
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
