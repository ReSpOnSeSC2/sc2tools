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
  // includeCatalog: false — this mode is a collection of builds the
  // user has actually engaged with (played / community / authored).
  // Catalog stubs with zero plays would dilute the binder with rows
  // that always render as bronze rarity with attack=0.
  const universe = buildUniverse(input.data, { includeCatalog: false });
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

function score(): ScoreResult {
  return { raw: 1, xp: 0, outcome: "correct" };
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

  // Auto-unlock cards as soon as the user opens the binder. The unlock
  // is single-pass; cards already in state are no-ops.
  useEffect(() => {
    for (const c of ctx.question.cards) {
      unlockCard(c.slug);
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
          <CardBinder
            cards={ctx.question.cards}
            renderCardFace={(c) => (
              <span className="flex flex-col items-center gap-1.5">
                <Icon
                  name={raceIconName(coerceRace(c.race))}
                  kind="race"
                  size={28}
                  decorative
                />
                <span className="line-clamp-2 text-center text-caption font-medium text-text">
                  {c.name}
                </span>
                <span className="font-mono text-[10px] uppercase tracking-wider text-text-dim">
                  ATK {c.attack} · DEF {c.defense}
                </span>
              </span>
            )}
          />
        </div>
      }
    />
  );
}
