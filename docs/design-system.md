# SC2 Tools web design system

This guide describes the web app as implemented in `apps/web`. It covers the
analyzer, public pages, Settings and shared web controls. Native desktop widgets
and OBS rendering have their own constraints; this document does not make their
palettes or accessibility behavior identical to the website.

## Sources of truth

| Concern | Implementation |
| --- | --- |
| Theme palettes, replay scope, global focus and motion | [globals.css](../apps/web/app/globals.css) |
| Utility names, fonts, type scale and named layers | [tailwind.config.ts](../apps/web/tailwind.config.ts) |
| Committed fonts and pre-paint appearance setup | [layout.tsx](../apps/web/app/layout.tsx) |
| Saved mode, resolved palette, OS and cross-tab updates | [theme.ts](../apps/web/lib/theme.ts) |
| Contrast calculation and documentation table | [contrast-tokens.mjs](../apps/web/scripts/contrast-tokens.mjs) |
| Shared controls | [components/ui](../apps/web/components/ui) |

Colors are space-separated RGB channel triples, used through
`rgb(var(--token) / <alpha-value>)`. Define theme values in CSS and expose their
roles in Tailwind. Keep both root palettes and any affected `.replay-scope`
overrides consistent. The older overlay token files are not the source for these
web utilities.

## Color roles

The ground is cool blue-black in Dark and pale paper in Light. Cards use solid
surfaces, a visible outline and a hard offset shadow. Cyan/teal marks interaction;
amber `signal` is reserved for occasional emphasis. Clay `editorial` colors give
public editorial layouts a separate accent.

| Token | Dark | Light | Role |
| --- | --- | --- | --- |
| `--bg` | `#06090e` | `#f4f6fa` | Page ground |
| `--bg-surface` | `#0c1017` | `#ffffff` | Card/control surface |
| `--bg-elevated` | `#111720` | `#f9fbfe` | Raised/hover surface |
| `--bg-subtle` | `#1a212e` | `#ebeff5` | Subtle fill |
| `--text` | `#e7edf0` | `#0d121a` | Primary text |
| `--text-muted` | `#9fadb9` | `#3f4856` | Secondary text |
| `--text-dim` | `#86929f` | `#515b6b` | Low-priority text |
| `--accent` | `#157d8c` | `#0e7d8c` | Primary fill |
| `--accent-hover` | `#096875` | `#096875` | Primary hover fill |
| `--accent-ink` | `#1f9eaf` | `#08666d` | Accent text |
| `--accent-ink-hover` | `#3ce0d6` | `#096875` | Accent hover text |
| `--accent-cyan` | `#3ce0d6` | `#08666d` | Cyan emphasis |
| `--signal` | `#f5b84a` | `#8f5c0c` | Rare warm emphasis |
| `--signal-hover` | `#fac86e` | `#7a4e0a` | Warm hover |
| `--editorial` | `#d6846e` | `#a54834` | Editorial accent |
| `--editorial-soft` | `#e8b2a2` | `#9d4f3b` | Editorial secondary accent |
| `--success` | `#3ec884` | `#157a43` | Success/win text |
| `--warning` | `#e89c38` | `#8f5f0f` | Caution text |
| `--danger` | `#ff6b6b` | `#b8333a` | Error/loss text |
| `--danger-fill` | `#c9363c` | `#b8333a` | Destructive fill |
| `--player-you` | `#6092ff` | `#2563eb` | Your comparison series |
| `--player-opp` | `#ff6363` | `#d62839` | Opponent comparison series |
| `--race-protoss` | `#7c8cff` | `#4a5ae6` | Protoss series |
| `--race-terran` | `#ff6b6b` | `#b8333a` | Terran series |
| `--race-zerg` | `#a78bfa` | `#7154d7` | Zerg series |
| `--race-random` | `#96a4b0` | `#546072` | Random series |
| `--border` | `#5c697c` | `#7c879b` | Control boundary |
| `--border-strong` | `#75849b` | `#65738a` | Stronger boundary |
| `--line` | `#5c697c` | `#0d121a` | Structural outline |

### Separate text ink from filled controls

The same color cannot serve every foreground and background role. Tailwind maps
these utilities deliberately:

| Utility or CSS token | Role |
| --- | --- |
| `text-accent` / `--accent-ink` | Links, active labels and accent text on a solid page/card surface |
| `hover:text-accent-hover` / `--accent-ink-hover` | Accent text on hover |
| `bg-accent`, `hover:bg-accent-hover` | Filled controls with `text-white` |
| `text-danger` / `--danger` | Error and loss text |
| `bg-danger` / `--danger-fill` | Destructive control fill with `text-white` |
| `text-accent-cyan` | Strong cyan emphasis; uses a darker teal in Light |
| `border-border`, `border-border-strong`, `border-line` | Boundaries and structural outlines |

`text-accent` does **not** read `--accent`. Likewise, `bg-danger` does **not** read
`--danger`. For inline styles, choose the equivalent ink or fill token explicitly.
Do not put white body text on a semantic text token merely because its name
matches a button's purpose.

Use `text-text` for primary text, `text-text-muted` for secondary text and
`text-text-dim` for lower-priority labels. All three pass the tested solid-surface
matrix at full opacity. Reducing opacity, adding a translucent background or
placing text on an image creates a new pair that needs its own check.

Race tokens identify Protoss, Terran, Zerg and Random; player tokens identify you
and the opponent in comparisons. Keep a visible name, icon, pattern or status
label alongside meaningful color. A win, error or selected state must remain
understandable without distinguishing hues.

### Replay and overlay surfaces

`.replay-scope` sets a self-contained dark palette and `color-scheme: dark`, even
inside a Light page. Its ground is `#070a0f`, surface `#0c1018` and elevated
surface `#141a24`; its text and interaction tokens are overridden as well. Use
those scoped variables for surrounding player controls rather than borrowing a
light-page color. The matrix below explicitly checks this mixed-theme case.

OBS browser sources may composite transparent content over arbitrary footage.
A contrast ratio against a website surface says nothing about that footage.
Review the chosen overlay skin, its actual backing panel and broadcast-size text
separately. Do not assume the web theme automatically controls every overlay.

## Generated contrast matrix

The table below is generated from the declarations in `globals.css`, using the
same matrix as [contrastTokens.test.ts](../apps/web/lib/__tests__/contrastTokens.test.ts).
For text and boundaries, each cell is the **lowest** ratio across ground
(`bg`), surface (`bg-surface`) and elevated (`bg-elevated`). Fill rows compare
white directly with that fill. Replay on light combines the Light root with its
replay overrides, including tokens that would otherwise inherit.

The contract uses at least 4.5:1 for these text pairs and at least 3:1 for the
listed boundaries and chart marks. It does not rely on a large-text exception. Ratios displayed
here are rounded; tests compare the unrounded values.

| Pair (worst of ground, surface and raised) | Dark | Light | Replay on light | Minimum |
| --- | ---: | ---: | ---: | ---: |
| text | 15.22:1 | 17.35:1 | 15.06:1 | 4.5:1 |
| text-muted | 7.84:1 | 8.54:1 | 8.92:1 | 4.5:1 |
| text-dim | 5.68:1 | 6.35:1 | 6.15:1 | 4.5:1 |
| accent-ink | 5.63:1 | 6.20:1 | 5.46:1 | 4.5:1 |
| accent-ink-hover | 10.99:1 | 5.97:1 | 10.66:1 | 4.5:1 |
| accent-cyan | 10.99:1 | 6.20:1 | 10.67:1 | 4.5:1 |
| signal | 10.14:1 | 5.24:1 | 9.84:1 | 4.5:1 |
| signal-hover | 11.61:1 | 6.64:1 | 11.27:1 | 4.5:1 |
| editorial | 6.33:1 | 5.43:1 | 6.14:1 | 4.5:1 |
| editorial-soft | 9.70:1 | 5.37:1 | 9.41:1 | 4.5:1 |
| success | 8.40:1 | 4.98:1 | 8.15:1 | 4.5:1 |
| warning | 7.92:1 | 5.09:1 | 7.68:1 | 4.5:1 |
| danger | 6.48:1 | 5.43:1 | 6.29:1 | 4.5:1 |
| player-you | 6.04:1 | 4.78:1 | 5.86:1 | 4.5:1 |
| player-opp | 6.18:1 | 4.60:1 | 6.00:1 | 4.5:1 |
| race-protoss | 6.04:1 | 4.98:1 | 5.86:1 | 4.5:1 |
| race-terran | 6.48:1 | 5.43:1 | 6.29:1 | 4.5:1 |
| race-zerg | 6.61:1 | 4.91:1 | 6.41:1 | 4.5:1 |
| race-random | 7.05:1 | 5.89:1 | 6.84:1 | 4.5:1 |
| chart-low-sample | 7.84:1 | 6.35:1 | 7.61:1 | 4.5:1 |
| chart-wr-low | 6.48:1 | 5.43:1 | 6.29:1 | 4.5:1 |
| chart-wr-mid | 10.14:1 | 5.24:1 | 9.84:1 | 4.5:1 |
| chart-wr-high | 8.40:1 | 4.98:1 | 8.15:1 | 4.5:1 |
| white on accent | 4.83:1 | 4.85:1 | 4.83:1 | 4.5:1 |
| white on accent-hover | 6.46:1 | 6.46:1 | 6.46:1 | 4.5:1 |
| white on danger-fill | 5.15:1 | 5.88:1 | 5.15:1 | 4.5:1 |
| border | 3.23:1 | 3.35:1 | 3.13:1 | 3:1 |
| border-strong | 4.74:1 | 4.44:1 | 4.60:1 | 3:1 |
| line | 3.23:1 | 17.35:1 | 3.13:1 | 3:1 |
| chart-low-sample mark | 7.84:1 | 6.35:1 | 7.61:1 | 3:1 |
| chart-wr-mid mark | 10.14:1 | 5.24:1 | 9.84:1 | 3:1 |

Regenerate the table after a token change; do not hand-edit ratios:

```sh
node apps/web/scripts/contrast-tokens.mjs
```

From `apps/web`, run the corresponding contract test:

```sh
npx vitest run lib/__tests__/contrastTokens.test.ts
```

The matrix is a check of named, opaque pairs. It does not verify gradients,
translucent states, disabled controls, arbitrary chart marks, images, canvas
pixels or every combination of utilities in a rendered page.

## Appearance: Light, Dark and System

`ThemeMode` is the saved preference (`light`, `dark` or `system`); `Theme` is the
resolved palette (`light` or `dark`). Keep these types separate when consuming
[theme.ts](../apps/web/lib/theme.ts).

- The browser stores an explicit choice under `sc2tools.theme`. Missing or
  invalid storage means System. Blocked storage still permits a choice in the
  current tab.
- The synchronous head bootstrap resolves the mode before first paint. It sets
  `data-theme-mode`, the resolved `data-theme` and `color-scheme` on `<html>`.
- `ThemeSync` subscribes for the lifetime of the page. Controls share one storage
  listener and an OS `matchMedia` listener only while System is active. Forcing
  Light or Dark stops following OS changes; choosing System resumes it.
- Storage changes from another tab update the current page. Merely defaulting to
  System does not write a preference.
- The layout exports Light and Dark media variants for `theme-color`. Bootstrap
  and runtime updates rewrite the meta elements to the resolved palette, so a
  forced choice also controls supported browser chrome. The colors are
  `#f4f6fa` for Light and `#06090e` for Dark.

The More sheet and MobileNav footer contain `ThemeChoice`: Sun, Moon and Monitor
buttons in a three-option radiogroup. Arrow keys wrap through choices; Home and
End choose the first and last. Only the selected option is in the normal tab
order. The account menu's Appearance action opens the same chooser in a Modal;
the Clerk menu retains its supported default actions.

The context-bar `ThemeToggle` stays a one-click palette switch. Clicking chooses
the opposite resolved palette and exits System. Press and hold, right-click or
press Arrow Down to open all three modes. This shortcut supplements the labeled
chooser; it is not the only way to reach System.

## Typography

Fonts are committed Latin WOFF2 files loaded through `next/font/local`, so the
production build does not depend on Google Fonts. The layout uses `display: swap`
and fallback metrics.

| Utility | Family | Use |
| --- | --- | --- |
| `font-sans` | Hanken Grotesk, then system sans | Body, labels and regular UI |
| `font-display` | Bricolage Grotesque, then Hanken/system sans | Headings, wordmark, prominent numbers and button labels |
| `font-serif` | Fraunces, then system serif | Editorial landing-page headings; not preloaded on every route |
| `font-mono` | System monospace | Atomic timings, aligned counts and technical values |

The root heading rules apply the display face to `h1` through `h4`. Heading
semantics and visual size are independent: choose the correct heading level,
then a scale utility. Use `PageHeader` for a page heading; use its section mode
and `as="h2"` where the app context already supplies the page's `h1`.

| Utility | Size / line height | Default role |
| --- | --- | --- |
| `text-display-xl` | 64 / 68 px | Large display headline |
| `text-display-lg` | 48 / 52 px | Display headline |
| `text-h1` | 36 / 42 px | Page title |
| `text-h2` | 28 / 34 px | Major section |
| `text-h3` | 22 / 28 px | Section/card title |
| `text-h4` | 18 / 24 px | Small heading |
| `text-body-lg` | 17 / 26 px | Introductory copy |
| `text-body` | 15 / 24 px | Body and regular UI |
| `text-caption` | 13 / 20 px | Secondary labels |
| `text-micro` | 12 / 16 px | Dense labels/overlines; smallest shared scale token |
| `text-mono` | 14 / 22 px | Numeric/technical readout |

Use tabular numerals where values need comparison. A number inside a sentence
can stay in the body face. Do not shrink essential instructions to make a layout
fit; allow wrapping or change the layout.

## Layout, surfaces and layers

Use Tailwind's existing spacing and radius utilities. There is no separate
cross-platform `--space-*` or `--radius-*` contract for the current web app.
Common shared patterns are 16px card bodies (`p-4`), 16px horizontal/12px vertical
card headers (`px-4 py-3`), and 8–16px gaps between related controls or sections.
Responsive layouts can use other existing scale steps where their content needs
them.

`Card` uses `rounded-xl`, a 2px structural outline and `shadow-hard`. Default and
elevated variants currently share `bg-bg-surface`; the feature variant changes
the outline to accent. Its default `overflow-hidden` clips descendants, so menus
that must escape a card need an intentional portal or a scoped overflow change.
`Card.Header`, `.Body` and `.Footer` support explicit composition; the legacy
`title`/`right` props remain available.

The hard shadow is 3px by 3px without blur: cyan-tinted in Dark and near-black in
Light. `shadow-halo-cyan` and `shadow-halo-accent` are decorative emphasis, not a
replacement for a visible boundary.

AppChrome content is capped at 1680px, with 16px phone padding, 24px from `sm` and
32px from `lg`. Reading pages can use a narrower measure. Keep grid/flex children
shrinkable (`min-w-0`) and put wide tables or tab strips in their own horizontal
scrollers. Body clipping must not conceal an unusable table or inaccessible
control. Check long labels, zoom and narrow viewports with real content.

### Layers and the bottom edge

| Named utility | z-index | Purpose |
| --- | ---: | --- |
| `z-nav` | 40 | App rail and mobile tab bar |
| `z-sheet` | 50 | Navigation sheets/drawers |
| `z-banner` | 50 | Save bar, update prompt and floating banners |
| `z-toast` | 60 | Toasts |

Use these named utilities for new viewport-pinned surfaces. The context bar is
at 30. Modal and Popover start at 50; React-owned nested overlays add one layer,
capped at 59 below Toast. This context crosses React portals. A custom portal
host must still permit normal stacking: a child's z-index cannot escape an
ancestor's CSS stacking context. Other sheets and banners sharing 50 still need
an overlap check. The skip link sits above the normal chrome.

AppChrome measures its mobile tab bar, including safe-area padding, and publishes
`--chrome-bottom`. It is zero from `md` and removed outside the app. A floating
bottom surface such as `SaveBar` uses `bottom-above-chrome`:

```css
bottom: calc(max(var(--chrome-bottom, 0px), env(safe-area-inset-bottom, 0px)) + 0.75rem);
```

This leaves 12px above the tab bar or safe area. A dialog's own footer stays
inside the dialog. Top-pinned app chrome accounts for `safe-area-inset-top`;
additional fixed surfaces need to account for the same inset where relevant.

## Controls, forms and dialogs

### Buttons and navigation

Use `Button` for an action and `LinkButton` for navigation. Both are exported by
[Button.tsx](../apps/web/components/ui/Button.tsx); there is no separate
`LinkButton.tsx`. Server components can import `buttonClassName` from
[buttonStyles.ts](../apps/web/components/ui/buttonStyles.ts) to style a `Link`
without importing the client Button module.

Both share `primary`, `secondary`, `ghost` and `danger` variants. Sizes are
`sm` (36px high), `md` (44px, the default) and `lg` (48px), each with a minimum
44px width. Small buttons therefore do **not** automatically provide a 44px-high
touch target. Use a larger size or an explicit minimum height for phone actions
that need it. Give icon-only actions an accessible name.

`IconButton` requires `aria-label` and supplies a 44px target. `CopyButton` and
`useCopy` copy only on explicit activation, bound the attempt to five seconds
and provide selected, visible read-only text when automatic copying fails.
Supply a scope key for owner/resource changes; stale results cannot update the
new context. Escape dismisses the manual fallback and returns to its button.

`Button` defaults to `type="button"`. Set `type="submit"` for form submission.
Its `loading` state disables the native button and sets `aria-busy`; callers own
progress copy and focus if the focused submit becomes disabled. `LinkButton`
remains an anchor and has no Button loading/disabled contract. Do not nest a
button or link inside another interactive control.

### Forms and unsaved changes

Use `Field` around a single `Input` or `Select` for a visible label and associated
hint/error. `Field` wires IDs, `aria-describedby` and `aria-invalid` onto its
single child. If the child already has an ID, pass the same value as `htmlFor`.
Composite controls must forward those attributes or wire their labels themselves.
Errors use text as well as a danger color and render with
`role="alert"`. Mark required native controls explicitly; the `Field` required
asterisk is only a visual label cue.

`Input` and `Select` keep native form behavior. Their heights are 32px (`sm`),
40px (`md`) and 48px (`lg`), so choose or extend sizes deliberately for the
surface's touch requirements. Preserve readable labels, native keyboard access
and a visible focus treatment.

Settings forms use `useDirtyForm` with `SaveBar` where appropriate. Keep drafts
separate from the saved state, show saving/error feedback, and do not make a
network failure look like a successful save. `SaveBar` floats above app chrome;
modal forms use their own footer.

### Dialogs

Use the existing portal-based `Modal` for dialogs. It supplies a labeled
`role="dialog"`, optional description, body scroll lock and `useFocusTrap`.
The default phone layout is a bottom sheet; from `sm` it is centered. Optional
`mobileLayout="center"` and `desktopLayout="side"` support the existing alternate
layouts. Body content scrolls within the bounded dialog and footer actions wrap.
Use `portalContainer` when a dialog must remain inside a fullscreen player.

`Sheet` reuses Modal's dismissal, footer, focus and scroll-lock contract with
`side="bottom"` or `side="right"`. Modal's additive `placement` option supports
those fixed placements; its default responsive behavior stays the same.

Set `initialFocusRef` when the first control is not the right starting point.
The shared focus scope handles Tab/Shift+Tab, Escape and focus return, including
portalled child dialogs. Keep the trigger mounted or provide a sensible focus
return target in the calling flow. `hideClose` only hides the X;
`disableScrimClose` only disables scrim dismissal. Callers must gate `onClose`
when a pending operation needs to block Escape/close, and keep an in-dialog focus
target available while action buttons are disabled.

`ConfirmDialog` is the current confirmation preset. Use `intent="danger"` for a
destructive action and `focusCancel` when the safe action should receive initial
focus. It does not implement typed-delete validation or every pending-operation
policy; specialized replay confirmations handle those requirements themselves.
`useConfirm(scopeKey)` returns `confirm`, `cancel` and one `dialog` outlet. It
settles cancellation, unmount or scope changes as false and rejects a concurrent
ask as false. Actual mutations stay with the caller. Preserve existing typed
`UNPAIR` and specialized controlled destructive flows.

`Popover` is a controlled, named nonmodal dialog anchored by `anchorRef`. Its
trigger supplies `aria-expanded` and matching `aria-controls`/`id`. It flips and
clamps to the viewport, dismisses on Escape or an outside pointer, and has no
body lock or Tab trap of its own. An enclosing Modal retains Tab containment
through registered nonmodal portals; Escape dismisses the top layer first.
Use `autoFocus={false}` when a lazy consumer must wait for ready content, as the
notification panel already does. An outside button/input keeps native focus;
nonfocusable outside dismissal restores the anchor when focus would be lost.

## Keyboard, focus and motion

Global link and focus defaults live in Tailwind's `@layer base`. Links use accent
ink; hover uses accent-hover ink. The base focus-visible rule draws a 2px accent
outline with a 2px offset and follows the element's own corners. Components may
replace it with an explicit focus ring, but removing the outline requires a
visible replacement.

State selectors use `:where()` so utilities can override defaults. A link with
its own `text-*` class also needs an intentional hover style. Avoid unlayered
universal or element pseudo-class rules that override every control; the cascade
regression test protects this boundary.

Use native links/buttons and meaningful heading order. The skip link targets
`main-content`. MobileNav traps focus, ignores hidden/disabled/non-tabbable
controls, closes with Escape and returns focus to its trigger. Check keyboard
entry, wrapping, Escape and return focus whenever a menu or dialog changes.
Use local horizontal reveal for passive tab updates; reserve page navigation for
an explicit user action.

The shared motion defaults are `--dur-base: 150ms`,
`--ease-out: cubic-bezier(0.2, 0, 0, 1)` and
`--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1)`. Some existing component animations
have their own durations. The global reduced-motion query sets CSS animation and
transition durations to zero and scroll behavior to `auto`; use `motion-safe`
for optional motion. JavaScript/canvas animation and imperative smooth scrolling
must check the preference themselves. Avoid motion as the sole way to convey a
state change.

## Data states and page anatomy

Use a stable page heading, then filters/actions and the content. `PageHeader`
actions wrap; admin pages use `AdminPageHeader`, labeled filters and
`AdminPagination`. Keep loading, failure, empty and ready states distinct.

`QueryState` is the existing shared adapter for `useApi`: skeleton before the
first answer, `RequestError` with Retry on a failed request, a relevant empty
state for a successful empty answer, then content. A failed background refresh
can retain current data. Private query helpers mask a previous owner's data;
previous-filter data is permitted only within the supported same-owner/resource
scope. Do not render one owner's fallback data as another owner's result.

Use shaped `Skeleton` content to limit layout shifts. Filtered empty states should
offer an action that changes the answer, such as Clear filters or All time.
Independent sections can use `SectionBoundary` so a render failure does not blank
the whole page. A boundary alone does not retry a cached failed lazy import;
optional lazy islands need their established retry-loader pattern as well.
`SkeletonChart` and `SkeletonKpi` add named, busy placeholders to the existing
skeleton family; they contain no fabricated values.

## Charts

Use `lib/charts/theme.ts` (`useChartKit`) on the existing `useChartTheme`
foundation. The old hook fields remain compatible. The kit supplies resolved
grid/axis colors, 12px ticks, tooltip styles, eight paired series colors, a
theme-aware win-rate ramp, sample cues and the existing reduced-motion signal.
`--series-1` through `--series-8`, `--chart-low-sample` and the three
`--chart-wr-*` endpoints live in globals.css, including replay overrides.

Use the existing ChartTooltip API for legible token-based header/value text.
Use ChartFrame around the plot for its title/legend, QueryState, summary and
same-data table toggle. A frame may hide its own visible title when its existing
Card already supplies one. Keep tables keyboard-scrollable, with real headers
and the same callbacks/rows as the visual; do not fetch another data set for it.

Categories such as MMR or macro-score bands use WinRateComparison on a shared
percentage scale. Separate counts from percentages; do not add a second axis or
a line that implies a continuous progression across categories. Preserve the
endpoint's denominator even when its sample qualifier counts decided results.
Under 20 decided results are hollow/dim. Mechanics averages instead qualify the
measured count; absent counts are uncertain. These cues do not establish a true
win probability or a causal effect.

Series have visible labels and overflow dash patterns. Color-pair tests require
CIE76 ΔE of at least 15 both normally and under the documented deuteranopia
simulation; the palette also meets contrast checks in Dark, Light and Replay on
light. This regression guard supplements labels and tables rather than replacing
them. Reduced motion must not change values or prevent selection/drilldown.
See ADR0066 and the Phase 2 Trends review for scope and compatibility details.

## Accessibility checks and limits

The public statement at [/legal/accessibility](../apps/web/app/legal/accessibility/page.tsx)
sets a **WCAG 2.2 Level AA target**, describes known limits and explains how to
report a barrier. [Help: Accessibility & appearance](../apps/web/lib/help/articles/account-data/appearance.ts)
covers the user-facing controls.

Current automated checks include:

- The source-derived contrast matrix for Dark, Light and Replay on light.
- All seven shared Badge variants composited over the three tested surfaces in
  those themes (63 additional pairs). Status tints remain subtle enough to keep
  their semantic text readable on the page ground as well as white cards.
- `@axe-core/playwright` in `tests/e2e/public-pages.spec.ts`, using the
  `wcag2a`, `wcag2aa` and `wcag21aa` tags. Serious/critical findings fail unless
  an exact page/theme/viewport-project/rule/target entry has a reviewed reason in
  `accessibility-allowlist.json`; no global rule disable is the escape hatch.
- Public-page checks in both themes at the viewport projects in
  `playwright.config.ts`, including page rendering and body overflow checks.
- Targeted keyboard/focus consumers and browser proof for the skip link,
  MobileNav, shared dialogs and the changed flow.
- Recommended `eslint-plugin-jsx-a11y` rules as warnings, alongside the existing
  lint checks.
- `npm run ui:lint` checks normalized file/rule signatures and occurrence counts;
  new and stale debt fail. The narrow before-paint browser metadata token
  exception is documented in `apps/web/scripts/ui-lint/README.md`. `ui:lint`
  also rejects new native `title` tooltips on analyzer table headers, which never
  appear on touch or keyboard: explain a header or metric label with
  `InfoTip`, SortableTh's `info` slot or `Term` instead.

The server-gated `/admin/design` gallery demonstrates actual controls and local
states with synthetic values. A current explicit admin response is required
before its examples mount; the whole access check has a five-second deadline.
Its sample actions do not read replays or write application data.

Run the appropriate contract/consumer tests for a changed primitive, then its
actual rendered keyboard and responsive flow. Review axe `incomplete` results
and lower-severity findings too; a serious/critical CI gate does not establish
complete accessibility. Do not add a broad allowlist entry to hide a regression.

Replay maps and some charts convey spatial information in canvas or other visual
rendering. Text controls and event lists provide partial alternatives, not a
complete description of every visual event. OBS overlays are broadcast visuals.
Clerk account forms and embedded players also depend on third-party behavior.
Test the task with real keyboard use and relevant assistive technology; passing
these automated checks is not a full conformance claim.

## Changing the system

1. Change the relevant root tokens and replay overrides in `globals.css`, then
   expose the intended ink/fill role in Tailwind where needed.
2. Run the contrast contract and regenerate the table in this document from
   `contrast-tokens.mjs`.
3. Check the actual light/dark rendered state, focus, hover, narrow-screen layout
   and reduced-motion behavior. New translucent/image/canvas combinations need
   their own evidence.
4. Reuse the current shared primitives and add focused consumer regression
   coverage for changed behavior. Update the public statement or appearance Help
   only when their user-facing contract changes.

A token test protects its declared pair, not every screen that uses it. Keep the
implementation, this guide and the visible behavior in agreement.
