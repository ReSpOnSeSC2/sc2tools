# ADR 0099: Command Glass visual system

Status: Accepted, November 24, 2026. Amends the border roles in ADR 0061
(`docs/adr/0061-contrast-and-appearance.md`) and extends ADR 0078
(`docs/adr/0078-desktop-design-tokens.md`).

## Context

The web app and the desktop agent wore the "Courtside" language: 2px ink
outlines on every card, button and field, a hard 3px offset shadow that
collapsed on press, a dot-grid backdrop, and three typefaces (Hanken
Grotesk for UI, Bricolage Grotesque for display, Fraunces for a serif
magazine landing page). It was distinctive, but it read as heavy and busy,
the three voices fought each other, and every surface carried the same
visual weight, so screens had little hierarchy. The owner asked for a
cleaner, sleeker, cutting-edge, production-grade look on mobile and
desktop, and in the agent, without losing any functionality.

Constraints that shaped the answer:

- No new font or asset downloads, no new npm dependencies, and no new
  client JavaScript in shared layouts (per-route JS budgets are enforced).
- The tested contrast contract (`lib/__tests__/contrastTokens.test.ts`) and
  the chart palette contract (series contrast and colour-vision distance)
  must keep passing.
- About 1,300 web components: the change has to propagate through tokens
  and primitives, with codemods for the patterns that carried the old look,
  rather than hand edits everywhere.

## Decision

Adopt **Command Glass**, a precision broadcast-HUD language where depth
comes from light rather than outlines.

1. **Surfaces and elevation.** A deep blue-black ground (`#05070b`) with
   tonal surfaces that step lighter (`bg-surface`, `bg-elevated`,
   `bg-subtle`), a faint top sheen (`--sheen`, `.surface-sheen`), and soft
   layered shadows: `--shadow-card` at rest (the legacy name
   `--shadow-hard` now holds the same value, so its ~110 call-sites follow),
   `--shadow-pop` for floating surfaces and `--shadow-glow` for interactive
   emphasis. Floating chrome (top bar, rail, tab bar, dialogs, popovers,
   toasts) uses frosted `.glass` / `.glass-strong` at 74% / 88% opacity
   with an opaque fallback where `backdrop-filter` is unsupported.
2. **Two border roles.** `--border` and `--line` become decorative
   hairlines (dividers, card and panel edges), tested at a visibility floor
   of 1.15:1. `--border-strong` is the control boundary (text fields,
   selects, switches, outlined controls) and keeps the WCAG 1.4.11 3:1
   minimum. A hairline is never the only cue that something is a control.
   A codemod moved 118 raw `<input>`, `<select>` and `<textarea>` edges to
   `border-border-strong`; the form primitives use it directly.
3. **Accent system.** Teal/cyan stays the interaction colour (`--accent`
   keeps white-on-fill contrast; `--accent-ink` brightens for links). A
   cyan → azure → violet aurora (`--aurora-1..3`) is reserved for brand
   moments: hero type (`.aurora-text`), the active-navigation beam
   (`.aurora-beam`, `.title-spine`), featured surfaces (`.aurora-ring`) and
   the progress bar. Every aurora stop clears 4.5:1 on every surface in its
   theme, so gradient type needs no large-text exception. Amber `signal`
   stays for rare emphasis.
4. **One typeface.** Hanken Grotesk (variable 100-900) for body, UI,
   headings and numbers; `font-display` is the same family at heavier
   weights with tighter tracking, and `font-serif` resolves to it as well.
   The layout preloads one font file instead of two plus a lazy serif.
5. **Shape and motion.** The radius scale is softened in Tailwind
   (`rounded-lg` 10px, `xl` 14px, `2xl` 18px). Buttons stay pills: lit
   fills with a top highlight and hover glow, a raised secondary on a
   hairline, and a gentle press scale instead of the collapsing offset
   shadow. Motion tokens are snappier (`--ease-out`
   `cubic-bezier(0.22, 1, 0.36, 1)`), with rise/scale/sheet/shimmer
   animations that the reduced-motion rule neutralises.
6. **Legacy names stay.** `hard-press`, `title-spine`, `rule-tick`,
   `overline`, `kicker`, `ed-rule` and `drop-initial` keep working and are
   restyled in place, so markup that uses them does not need edits.
7. **2px outlines retired.** A codemod changed 278 neutral 2px outlines
   (`border-2` beside `border-line`/`border-border`/transparent) to 1px
   across 164 files. Semantic 2px callouts keep their weight as a 1px
   border plus a matching 1px ring, so state changes never shift layout.
   OBS overlay and dock sources were excluded: they composite over
   footage and keep their own broadcast styling.
8. **Desktop agent.** The Qt token set in `ui/theme.py` follows the same
   family (ADR 0078 still governs how it mirrors tokens), keeping each race
   skin's canvas, accent, focus colour, brand mark and border art.

## Consequences

- `scripts/contrast-tokens.mjs` splits control borders (3:1) from
  decorative hairlines (1.15:1); the generated matrix in
  `docs/design-system.md` is regenerated from it.
- The colour mirrors move together: `THEME_COLORS` (`lib/theme.ts`),
  `THEME_TOKENS` (`lib/theme/tokens.ts`, Clerk) and `DARK_FALLBACK`
  (`lib/useChartTheme.ts`).
- Class-string edits change UI-lint ratchet signatures without adding
  violations; the baseline is rewritten and reviewed for equal or lower
  counts per rule.
- Text on glass is composited over content. Keeping glass at 74% opacity
  or more keeps it close to the solid-surface pairs the matrix tests, but
  the matrix does not test translucent pairs directly.
- OG images, share cards and the web manifest keep their literal colours;
  they are near-identical and are image renders, not themed UI.

## Alternatives considered

- **Polish Courtside in place.** Kept the heavy outlines and three voices
  that caused the problem.
- **A new downloaded typeface (for example Geist or Inter).** Rejected: no
  new downloads, and the variable Hanken Grotesk covers display weights.
- **Glass everywhere, including cards.** Rejected: stacked translucency
  makes contrast unpredictable and costs paint time on long pages. Glass
  is limited to floating chrome.
- **Lowering every border to a hairline, controls included.** Rejected:
  it would break WCAG 1.4.11 for form controls.
