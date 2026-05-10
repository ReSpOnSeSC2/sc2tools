"use client";

import { useArcadeState } from "../hooks/useArcadeState";

const ITEMS = [
  { id: "skin-foil", label: "Foil mascot skin", cost: 75, slot: "mascotSkin", value: "foil" },
  { id: "cardback-aurora", label: "Aurora card-back", cost: 100, slot: "cardBackTheme", value: "aurora" },
] as const;

export function CosmeticsShop() {
  const { state, update, spendMinerals } = useArcadeState();

  const owned = (slot: string, value: string) =>
    (state.cosmetics as unknown as Record<string, string>)[slot] === value;

  const buy = (item: (typeof ITEMS)[number]) => {
    if (owned(item.slot, item.value)) return;
    if (!spendMinerals(item.cost)) return;
    update((prev) => ({
      ...prev,
      cosmetics: { ...prev.cosmetics, [item.slot]: item.value } as typeof prev.cosmetics,
    }));
  };

  return (
    <div className="space-y-3">
      <p className="text-caption text-text-muted">
        Cosmetic-only. Mascot skins and card-back themes — no pay-to-win, no real money.
      </p>
      <ul role="list" className="space-y-2">
        {ITEMS.map((it) => {
          const have = owned(it.slot, it.value);
          return (
            <li
              key={it.id}
              className="flex items-center justify-between rounded-lg border border-border bg-bg-elevated px-3 py-2"
            >
              <span className="text-body text-text">{it.label}</span>
              <button
                type="button"
                onClick={() => buy(it)}
                disabled={have || state.minerals < it.cost}
                className="inline-flex min-h-[40px] items-center rounded-md bg-accent px-3 text-caption font-semibold uppercase tracking-wider text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {have ? "Owned" : `${it.cost} 💎`}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-caption text-text-dim">
        Balance: <span className="font-mono tabular-nums text-text">{state.minerals}</span>{" "}
        minerals
      </p>
    </div>
  );
}
