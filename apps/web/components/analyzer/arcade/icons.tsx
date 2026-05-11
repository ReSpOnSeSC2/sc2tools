// Per-mode icons. Two layers:
//
//   1. A bundled inline-SVG fallback for every mode (one per id) that
//      ships with the build. SVGs use currentColor so they pick up the
//      wrapping button's accent tint and respond to theme changes.
//   2. An optional PNG override per mode. Drop a file at
//      `apps/web/public/arcade/icons/<modeId>.png` AND add the mode id
//      to `CUSTOM_ICON_MODES` below. The IconFor() helper that every
//      shell + surface uses then swaps the SVG out for the PNG. See
//      `apps/web/public/arcade/icons/README.md` for the full convention.
//
// The set indirection (instead of an automatic PNG-first lookup) keeps
// the network quiet — modes without a custom icon never trigger a 404.

import type { ReactNode } from "react";

const ICON_PROPS = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
} as const;

function withTitle(label: string, body: ReactNode): ReactNode {
  return (
    <svg {...ICON_PROPS} role="img" aria-label={label}>
      <title>{label}</title>
      {body}
    </svg>
  );
}

/* ──────────────────────── Quizzes (10) ──────────────────────── */

const opponentBracketPick = () =>
  withTitle("Bracket pick", (
    <>
      <path d="M3 5h6v3M3 16h6v3M15 5h6v3M15 16h6v3" />
      <path d="M9 6.5h4v11h4M9 17.5h4" />
    </>
  ));

const rivalryRanker = () =>
  withTitle("Rivalry ranker", (
    <>
      <path d="M4 18h3l1-9 2 6 2-12 2 9 2-4h4" />
      <circle cx="20" cy="6" r="1.4" />
    </>
  ));

const activeStreakHunter = () =>
  withTitle("Active streak", (
    <>
      <path d="M12 3c2 3 4 5 4 8a4 4 0 11-8 0c0-2 1-3 2-5 0 2 1 3 2 4 0-3-1-5 0-7z" />
      <path d="M9 19h6" />
    </>
  ));

const streakVeto = () =>
  withTitle("Streak veto", (
    <>
      <path d="M5 12h14" />
      <path d="M5 6h14M5 18h14" opacity="0.4" />
      <circle cx="12" cy="12" r="9" />
    </>
  ));

const firstGameOfDay = () =>
  withTitle("First game of day", (
    <>
      <circle cx="12" cy="13" r="5" />
      <path d="M12 3v2M12 21v0M3 13h2M19 13h2M5.6 6.6l1.4 1.4M16.9 19.9l0 0M5.6 19.9l1.4-1.4M16.9 6.6l1.4 1.4" />
    </>
  ));

const streakAfterLoss = () =>
  withTitle("Bounce-back", (
    <>
      <path d="M4 14l4-4 4 4 4-6 4 6" />
      <path d="M4 19h16" opacity="0.5" />
    </>
  ));

const comebackCount = () =>
  withTitle("Comeback count", (
    <>
      <path d="M5 12a7 7 0 1112 5" />
      <path d="M5 12V8M5 12h4" />
      <path d="M19 19l-2-2 2-2" />
    </>
  ));

const lossPatternSleuth = () =>
  withTitle("Loss-pattern sleuth", (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M16 16l5 5" />
      <path d="M9 11h4M11 9v4" opacity="0.6" />
    </>
  ));

const closersEye = () =>
  withTitle("Closer's eye", (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ));

const macroMemory = () =>
  withTitle("Macro memory", (
    <>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M3 9h18M8 4v14" opacity="0.5" />
      <circle cx="14" cy="13" r="1.4" />
    </>
  ));

/* ──────────────────────── Games (6) ──────────────────────── */

const stockMarket = () =>
  withTitle("Stock market", (
    <>
      <path d="M3 18l5-6 4 3 4-7 5 4" />
      <path d="M3 21h18" opacity="0.5" />
      <circle cx="3" cy="18" r="1.2" />
      <circle cx="21" cy="12" r="1.2" />
    </>
  ));

const bingoLadder = () =>
  withTitle("Bingo: ladder edition", (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18M15 3v18M3 9h18M3 15h18" opacity="0.5" />
      <path d="M5 5l3 3M16 5l3 3M5 17l3-3M16 17l3 3" opacity="0.6" />
    </>
  ));

const buildle = () =>
  withTitle("Buildle", (
    <>
      <rect x="3" y="3" width="6" height="6" rx="0.6" />
      <rect x="11" y="3" width="6" height="6" rx="0.6" opacity="0.5" />
      <rect x="3" y="11" width="6" height="6" rx="0.6" opacity="0.5" />
      <rect x="11" y="11" width="6" height="6" rx="0.6" />
      <rect x="19" y="3" width="2" height="2" rx="0.4" opacity="0.4" />
      <rect x="19" y="19" width="2" height="2" rx="0.4" opacity="0.4" />
    </>
  ));

const twoTruthsLie = () =>
  withTitle("Two truths and a lie", (
    <>
      <path d="M5 6h14M5 12h14M5 18h14" />
      <path d="M3 6h0M3 12h0M3 18h0" />
      <path d="M16 9l5 5" />
      <path d="M21 9l-5 5" />
    </>
  ));

const higherOrLower = () =>
  withTitle("Higher or lower", (
    <>
      <rect x="4" y="4" width="7" height="16" rx="1.2" />
      <rect x="13" y="4" width="7" height="16" rx="1.2" opacity="0.55" />
      <path d="M16 8l4-3 0 6M16 16l4 3 0-6" />
    </>
  ));

const buildsAsCards = () =>
  withTitle("Builds as cards", (
    <>
      <rect x="3" y="6" width="11" height="14" rx="1.4" />
      <rect x="9" y="3" width="12" height="15" rx="1.4" opacity="0.55" />
      <path d="M6 10h5M6 14h4" opacity="0.7" />
    </>
  ));

/* ──────────────────────── SVG registry ──────────────────────── */

const SVG_REGISTRY: Record<string, () => ReactNode> = {
  "opponent-bracket-pick": opponentBracketPick,
  "rivalry-ranker": rivalryRanker,
  "active-streak-hunter": activeStreakHunter,
  "streak-veto": streakVeto,
  "first-game-of-day": firstGameOfDay,
  "streak-after-loss": streakAfterLoss,
  "comeback-count": comebackCount,
  "loss-pattern-sleuth": lossPatternSleuth,
  "closers-eye": closersEye,
  "macro-memory": macroMemory,
  "stock-market": stockMarket,
  "bingo-ladder": bingoLadder,
  "buildle": buildle,
  "two-truths-lie": twoTruthsLie,
  "higher-or-lower": higherOrLower,
  "builds-as-cards": buildsAsCards,
};

/* ──────────────────────── PNG override manifest ──────────────────────── */

/**
 * Mode ids that have a custom icon image at
 * `apps/web/public/arcade/icons/<modeId>.png`. Add an entry here when
 * you drop a PNG; remove it (or delete the PNG) to revert to the
 * bundled SVG. Entries with no matching file render a broken image —
 * keep the set in sync with what's actually on disk.
 */
export const CUSTOM_ICON_MODES = new Set<string>([
  "opponent-bracket-pick",
  "rivalry-ranker",
  "active-streak-hunter",
  "streak-veto",
  "first-game-of-day",
  "streak-after-loss",
  "comeback-count",
  "loss-pattern-sleuth",
  "closers-eye",
  "macro-memory",
  "stock-market",
  "bingo-ladder",
  "buildle",
  "two-truths-lie",
  "higher-or-lower",
  "builds-as-cards",
]);

const TITLES: Record<string, string> = {
  "opponent-bracket-pick": "Opponent Bracket Pick",
  "rivalry-ranker": "Rivalry Ranker",
  "active-streak-hunter": "Active Streak Hunter",
  "streak-veto": "Streak Veto",
  "first-game-of-day": "First-Game-of-Day",
  "streak-after-loss": "Streak-after-Loss",
  "comeback-count": "Comeback Count",
  "loss-pattern-sleuth": "Loss-Pattern Sleuth",
  "closers-eye": "Closer's Eye",
  "macro-memory": "Macro Memory",
  "stock-market": "Stock Market",
  "bingo-ladder": "Bingo: Ladder Edition",
  "buildle": "Buildle",
  "two-truths-lie": "Two Truths & a Lie",
  "higher-or-lower": "Higher or Lower",
  "builds-as-cards": "Builds as Cards",
};

/**
 * IconFor — single entry point used by every shell, surface, and mode
 * card. Returns a PNG override when the mode id is in
 * `CUSTOM_ICON_MODES`, otherwise the bundled inline SVG.
 */
export function IconFor(modeId: string): ReactNode {
  if (CUSTOM_ICON_MODES.has(modeId)) {
    const alt = TITLES[modeId] ?? modeId;
    return (
      <img
        src={`/arcade/icons/${modeId}.png`}
        alt={alt}
        loading="lazy"
        className="h-full max-h-7 w-auto object-contain"
      />
    );
  }
  const make = SVG_REGISTRY[modeId];
  if (make) return make();
  return withTitle("Arcade", <circle cx="12" cy="12" r="9" />);
}

export function hasIcon(modeId: string): boolean {
  return Object.prototype.hasOwnProperty.call(SVG_REGISTRY, modeId);
}

export const ALL_MODE_IDS = Object.keys(SVG_REGISTRY);
