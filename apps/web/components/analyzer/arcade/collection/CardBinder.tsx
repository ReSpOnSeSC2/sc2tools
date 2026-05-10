"use client";

import type { ReactNode } from "react";

const RARITY_BORDER: Record<string, string> = {
  bronze: "border-amber-700/50",
  silver: "border-zinc-400/60",
  gold: "border-amber-400/70",
  mythic: "border-fuchsia-400/70",
};

const RARITY_LABEL: Record<string, string> = {
  bronze: "Bronze",
  silver: "Silver",
  gold: "Gold",
  mythic: "Mythic",
};

export interface CardBinderProps<T extends { slug: string; rarity: string; foil?: boolean }> {
  cards: T[];
  renderCardFace: (card: T) => ReactNode;
}

export function CardBinder<T extends { slug: string; rarity: string; foil?: boolean }>(
  { cards, renderCardFace }: CardBinderProps<T>,
) {
  if (cards.length === 0) {
    return (
      <p className="text-caption text-text-muted">
        No cards yet. Play a game to start unlocking the binder.
      </p>
    );
  }
  return (
    <ul
      role="list"
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
    >
      {cards.map((c) => (
        <li
          key={c.slug}
          className={[
            "flex aspect-[3/4] flex-col items-center justify-center rounded-lg border-2 bg-bg-elevated p-2",
            RARITY_BORDER[c.rarity] ?? "border-border",
            c.foil ? "shadow-halo-cyan" : "",
          ].join(" ")}
        >
          {renderCardFace(c)}
          <span className="mt-1 rounded-full border border-border bg-bg-surface px-2 py-0.5 text-[10px] uppercase tracking-wider text-text-dim">
            {RARITY_LABEL[c.rarity] ?? c.rarity}
            {c.foil ? " · Foil" : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}
