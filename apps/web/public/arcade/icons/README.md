# Arcade icon overrides

Drop your custom icon image here as `<modeId>.png` and register the mode id in
[`apps/web/components/analyzer/arcade/icons.tsx`](../../../components/analyzer/arcade/icons.tsx)
under `CUSTOM_ICON_MODES`. The bundled inline-SVG fallback stays as a safety
net — it renders any time a mode id isn't in the set or the PNG fails to load.

## File convention

| File path | Mode |
|---|---|
| `opponent-bracket-pick.png` | Opponent Bracket Pick |
| `rivalry-ranker.png` | Rivalry Ranker |
| `active-streak-hunter.png` | Active Streak Hunter |
| `streak-veto.png` | Streak Veto |
| `first-game-of-day.png` | First-Game-of-Day |
| `streak-after-loss.png` | Streak-after-Loss |
| `comeback-count.png` | Comeback Count |
| `loss-pattern-sleuth.png` | Loss-Pattern Sleuth |
| `closers-eye.png` | Closer's Eye |
| `macro-memory.png` | Macro Memory |
| `stock-market.png` | Stock Market |
| `bingo-ladder.png` | Bingo: Ladder Edition |
| `buildle.png` | Buildle |
| `two-truths-lie.png` | Two Truths & a Lie |
| `higher-or-lower.png` | Higher or Lower |
| `builds-as-cards.png` | Builds as Cards |

## Recommended specs

- **Size**: 64×64 px, square. The renderer scales them via `object-contain` so
  smaller squares (32×32) work but look soft on retina.
- **Format**: PNG with transparency (alpha). The wrapper button has a dark
  surface — opaque rectangles will look like badges.
- **Color**: any. Unlike the SVG fallback (which inherits `currentColor`),
  PNGs render at their native colors. Use the analyzer's accent palette
  (cyan `#7DC8FF`, success `#28A06B`, warning `#DA9532`, danger `#DA4150`)
  if you want them to feel native.
- **Style**: each icon is a button face — distinct silhouettes matter more
  than detail. Aim for one bold central motif per mode.

## How to add an icon

1. Drop `<modeId>.png` in this directory.
2. Open `apps/web/components/analyzer/arcade/icons.tsx`.
3. Add the mode id string to `CUSTOM_ICON_MODES`:
   ```ts
   export const CUSTOM_ICON_MODES = new Set<string>([
     "stock-market",
     "buildle",
   ]);
   ```
4. That's it — the `IconFor(modeId)` helper that every shell, surface, and
   mode card uses will switch to the PNG automatically. Reverting is the
   inverse: remove the entry from the set (the SVG comes back) or delete
   the PNG.

## Why a manifest instead of auto-detect?

Trying every PNG path on every render would 404-spam the console for the 15
modes you haven't customized yet. The set lets the renderer decide
synchronously without a network round-trip.
