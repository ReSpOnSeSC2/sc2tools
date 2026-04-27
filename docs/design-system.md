# SC2 Tools — Design System

The SC2 Tools design system is the single source of truth for color,
typography, spacing, motion, and elevation across every surface we ship:
the React SPA analyzer, the Tkinter desktop GUI, the sixteen OBS browser-
source overlay widgets, and the future web dashboard / React Native mobile
app.

Token files (do not edit one without editing the others):

- `reveal-sc2-opponent-main/SC2-Overlay/design-tokens.css` — CSS custom
  properties on `:root`. Authoritative for any web surface.
- `reveal-sc2-opponent-main/SC2-Overlay/design-tokens.json` — Style
  Dictionary v4 format, consumed by the Node backend and any future build
  tooling that wants to emit native iOS / Android assets.
- `reveal-sc2-opponent-main/gui/design_tokens.py` — frozen dataclasses
  exposed as `COLORS`, `FONT_FAMILIES`, `FONT_SIZES`, `FONT_WEIGHTS`,
  `LINE_HEIGHTS`, `SPACING`, `RADII`, `MOTION`. Used by Tkinter /
  customtkinter / PyQt code.

If you change a token value in one file, change it in all three. CI will
flag drift.

## Color usage rules

The palette has three orthogonal axes — surface, race accent, and semantic
state. They never conflict; one always wins.

### Surfaces (`--color-bg-*`)

The dark space theme uses a three-level elevation ladder. Every UI lives
on one of these.

| Token            | Hex       | Use                                       |
| ---------------- | --------- | ----------------------------------------- |
| `bg-primary`     | `#0A0E1A` | Page / app background.                    |
| `bg-surface`     | `#111827` | Cards, panels, sidebars, dialog bodies.   |
| `bg-elevated`    | `#1F2937` | Hovered card, modal, tooltip, active row. |

The OBS overlay widgets float on a transparent OBS source, so they reach
into the `--color-overlay-*` group instead — see "Overlay legacy palette"
below.

### Race accents (`--color-race-*`)

Use for race-identifying chrome only — race chips, race badges, race-
tinted matchup labels, race-coded win-rate bars on the Matchups tab.

| Token          | Hex       |
| -------------- | --------- |
| `race-terran`  | `#3B82F6` |
| `race-zerg`    | `#A855F7` |
| `race-protoss` | `#F59E0B` |
| `race-random`  | `#94A3B8` |

Race accents NEVER carry win/loss meaning. A Zerg loss colors red, not
purple. If both a race accent and a semantic color apply to the same
element, the semantic color wins and the race accent moves to a secondary
chip or icon.

### Semantic state (`--color-success` / `danger` / `warning` / `info`)

| Token     | Hex       | Use                                              |
| --------- | --------- | ------------------------------------------------ |
| `success` | `#10B981` | Wins, healthy KPIs, completed steps.             |
| `danger`  | `#EF4444` | Losses, errors, blockers, destructive CTAs.      |
| `warning` | `#F59E0B` | Caution, low-confidence (n=1), stale data.       |
| `info`    | `#3B82F6` | Tip, hint, neutral CTA, "more info" affordances. |

Note: `warning` and `race-protoss` share a hex value (`#F59E0B`). That is
intentional — the spec defines them that way — but do not conflate them
in code. Use whichever token names the role you actually want.

### Text (`--color-text-*`)

| Token            | Hex       | Use                                                                   |
| ---------------- | --------- | --------------------------------------------------------------------- |
| `text-primary`   | `#F1F5F9` | Body copy, headings, button text.                                     |
| `text-secondary` | `#94A3B8` | Field labels, helper text, footnote rows.                             |
| `text-muted`     | `#64748B` | Timestamps, low-priority labels, decorative captions.                 |
| `text-on-accent` | `#0A0E1A` | Dark foreground when sitting on a race-accent or semantic-color fill. |

`text-muted` does NOT pass WCAG AA on `bg-elevated`. Never use it for body
copy on an elevated surface — promote it to `text-secondary`.

### Overlay legacy palette (`--color-overlay-*`)

The OBS browser-source widgets ship with a deliberately more saturated,
neon palette so they read clearly when composited over busy SC2 footage
on a livestream. These tokens are decorative and preserve that exact
look. New surfaces — analyzer SPA, Tkinter GUI, mobile, dashboard —
should prefer the semantic tokens above.

The overlay tokens cover: gradient endpoints, accent bars (gold, cyan,
purple, red, rival-amber), victory / defeat text colors, scout /
cheese / rival widget skins, build-step pills, and translucent fills
for win-streak / loss-streak chips. See `design-tokens.css` section 6
for the full list.

## Typography rules

Two families:

- `--font-family-ui` — **Inter** (with `system-ui` / `Segoe UI` fallbacks).
  Used for headings, body copy, button labels, every regular UI string.
- `--font-family-mono` — **JetBrains Mono** (with `Consolas` fallback).
  Used **only** for stats and timings:
  - MMR values and deltas (`+24 MMR`, `3120`).
  - Build-order timestamps (`3:42`).
  - Numeric counts in stat cards (`12W - 5L`).
  - Win-rate percentages (`64.7%`).

If a number is part of a sentence ("you played 47 games this week"), it
stays in the UI family. Mono is reserved for atomic numeric values that
need column alignment.

### Scale

| Token          | Pixels | Use                                                  |
| -------------- | ------ | ---------------------------------------------------- |
| `font-size-xs` | 11     | Footnotes, table tooltips, microcopy.                |
| `font-size-sm` | 13     | Helper text, small labels.                           |
| `font-size-base` | 15   | Body copy, default UI.                               |
| `font-size-lg` | 18     | Card titles, prominent labels.                       |
| `font-size-xl` | 22     | Sub-section headings.                                |
| `font-size-2xl`| 28     | Page-level headings.                                 |
| `font-size-3xl`| 36     | Hero numbers (session W-L), splash titles.           |

### Line height

`tight` (1.2) for hero numbers and headlines. `normal` (1.5) for body
copy. `relaxed` (1.75) for long-form text in dialogs and onboarding.

## Spacing rhythm

The spacing scale is `0 / 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96`,
exposed as `--space-0` through `--space-24` (the number is the multiple of
the 4 px base unit; `--space-6` = 24 px, `--space-12` = 48 px).

Pick the closest step. **Do not invent in-betweens** — `padding: 14px` is
not allowed; use `--space-3` (12) or `--space-4` (16).

Common pairings that keep vertical rhythm consistent:

- Section gap inside a card: `--space-4` (16).
- Stack of related rows in a list: `--space-2` (8).
- Card padding: `--space-6` / `--space-4` (24 vertical, 16 horizontal).
- Section heading → first content row: `--space-3` (12).
- Inter-card grid gap: `--space-4` (16) on desktop, `--space-3` (12) on
  mobile.

## Radii & shadows

| Radius          | Use                                              |
| --------------- | ------------------------------------------------ |
| `radius-sm` 4   | Inline pills, table cells.                       |
| `radius-md` 8   | Buttons, input fields, small cards.              |
| `radius-lg` 12  | Standard cards, modal bodies.                    |
| `radius-xl` 16  | Hero cards, OBS widget shells.                   |
| `radius-full`   | Avatars, race chips, segmented toggles.          |

Shadows use a four-step ladder (`sm` / `md` / `lg` / `xl`); reach for the
lowest one that still establishes the elevation you need. The overlay
widgets reuse `--shadow-overlay-card`, `--shadow-overlay-tile`, and
`--shadow-overlay-streak` to preserve the existing OBS-friendly drop.

## Motion

Three durations:

- `--duration-state` (200 ms) for hover, focus, toggle, color changes.
- `--duration-entrance` (400 ms) for cards mounting / dismissing.
- `--duration-celebrate` (600 ms) for the streak splash and match-result
  hero pop.

Three curves:

- `--ease-out` for state transitions (the value you usually want).
- `--ease-in-out` for entrance / exit.
- `--ease-spring` for celebration moments (rivalry alert pulse, MMR-up
  pop). Has a small overshoot baked into the cubic-bezier.

`design-tokens.css` already wraps motion tokens in a
`@media (prefers-reduced-motion: reduce)` block that zeroes every
duration, so OS-level reduce-motion is honored without extra work.

## Accessibility — WCAG AA contrast

Every text/background pair we ship is documented below with its contrast
ratio (computed from the WCAG 2.1 relative-luminance formula). WCAG AA
requires ≥ 4.5:1 for body text and ≥ 3:1 for large text (≥ 18 px regular
or ≥ 14 px bold).

### Text on surface

| Foreground       | Background     | Ratio  | Body | Large |
| ---------------- | -------------- | ------ | :--: | :---: |
| `text-primary`   | `bg-primary`   | 17.0:1 | ✅   | ✅    |
| `text-primary`   | `bg-surface`   | 15.2:1 | ✅   | ✅    |
| `text-primary`   | `bg-elevated`  | 11.9:1 | ✅   | ✅    |
| `text-secondary` | `bg-primary`   | 7.3:1  | ✅   | ✅    |
| `text-secondary` | `bg-surface`   | 6.5:1  | ✅   | ✅    |
| `text-secondary` | `bg-elevated`  | 5.1:1  | ✅   | ✅    |
| `text-muted`     | `bg-primary`   | 4.0:1  | ❌   | ✅    |
| `text-muted`     | `bg-surface`   | 3.6:1  | ❌   | ✅    |
| `text-muted`     | `bg-elevated`  | 2.8:1  | ❌   | ❌    |

Use `text-muted` only on `bg-primary` or `bg-surface`, only for large
text, and never on `bg-elevated`. For body copy on any surface, use
`text-secondary` or `text-primary`.

### Race & semantic accents on surface

| Foreground      | Background    | Ratio | Body | Large |
| --------------- | ------------- | ----- | :--: | :---: |
| `race-terran`   | `bg-primary`  | 5.2:1 | ✅   | ✅    |
| `race-terran`   | `bg-surface`  | 4.7:1 | ✅   | ✅    |
| `race-terran`   | `bg-elevated` | 3.7:1 | ❌   | ✅    |
| `race-zerg`     | `bg-primary`  | 4.8:1 | ✅   | ✅    |
| `race-zerg`     | `bg-surface`  | 4.3:1 | ❌   | ✅    |
| `race-zerg`     | `bg-elevated` | 3.3:1 | ❌   | ✅    |
| `race-protoss`  | `bg-primary`  | 8.7:1 | ✅   | ✅    |
| `race-protoss`  | `bg-surface`  | 7.8:1 | ✅   | ✅    |
| `race-protoss`  | `bg-elevated` | 6.1:1 | ✅   | ✅    |
| `race-random`   | `bg-primary`  | 7.3:1 | ✅   | ✅    |
| `race-random`   | `bg-surface`  | 6.5:1 | ✅   | ✅    |
| `race-random`   | `bg-elevated` | 5.1:1 | ✅   | ✅    |
| `success`       | `bg-primary`  | 7.4:1 | ✅   | ✅    |
| `success`       | `bg-surface`  | 6.6:1 | ✅   | ✅    |
| `success`       | `bg-elevated` | 5.1:1 | ✅   | ✅    |
| `danger`        | `bg-primary`  | 5.0:1 | ✅   | ✅    |
| `danger`        | `bg-surface`  | 4.4:1 | ❌   | ✅    |
| `danger`        | `bg-elevated` | 3.5:1 | ❌   | ✅    |
| `warning`       | `bg-primary`  | 8.7:1 | ✅   | ✅    |
| `warning`       | `bg-surface`  | 7.8:1 | ✅   | ✅    |
| `warning`       | `bg-elevated` | 6.1:1 | ✅   | ✅    |
| `info`          | `bg-primary`  | 5.2:1 | ✅   | ✅    |
| `info`          | `bg-surface`  | 4.7:1 | ✅   | ✅    |
| `info`          | `bg-elevated` | 3.7:1 | ❌   | ✅    |

Cells marked ❌ for body must either use the color for ≥ 18 px text only
(headings, hero numbers) or back the element with a darker surface.
`race-zerg` body copy on `bg-surface` (4.3:1) is the most common
near-miss; promote to a heading size or a chip with a tinted fill.

### Overlay widgets

Overlay widgets composite onto a transparent OBS source over arbitrary
SC2 footage. Their internal background is the gradient
`--color-overlay-bg-from` → `--color-overlay-bg-to` (≈ `#11141C`–`#1A1E29`),
which gives 16:1 contrast for `--color-overlay-text` (white) — well above
AA. Decorative accents (gold, cyan, purple, neon green for victory) are
used for chrome and large-text moments only; the body copy inside every
overlay card is white on the dark gradient.

### Reduced motion

All token-driven animations honor `@media (prefers-reduced-motion: reduce)`
because the motion tokens zero out under that media query. New components
should not use raw `transition` / `animation` durations — pull from
`--duration-*` and `--ease-*` so opt-out works automatically.

### Keyboard & focus

Beyond the token system: every interactive element gets a visible focus
ring. The default ring is a 2 px outline using
`--color-info` (`#3B82F6`) at full opacity, offset 2 px from the element.
This is established at component level (button, input, link) — see the
component documentation in `docs/component-library.md` (forthcoming).

## Adding a new token

1. Add the value to all three files (`design-tokens.css`,
   `design-tokens.json`, `design_tokens.py`).
2. If it's a color, document its WCAG AA pair coverage in this file.
3. Update `CHANGELOG.md` with a `feat(design-system):` entry.
4. Bump the design-tokens version in any future package.json that
   exports them.
