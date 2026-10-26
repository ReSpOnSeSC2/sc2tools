# Analyzer filter overlay migration

2026-10-25. Branch `codex/wave5-filter-overlays`, worktree
`wave3-private-scouting`, source base `105055e0`.

This is a bounded consumer pack for `ui-primitives-and-dialogs` in
`docs/handoff/plan/final-plan.json`, not completion of that item. Existing
shared primitives, focus ownership and accessibility foundations are reused.

## Source

- The phone Filters editor uses Sheet. Its immediate changes, active count,
  default reset, reset-to-Done focus and dismissal behavior remain.
- Desktop More filters, date selection and custom game length use nonmodal
  Popover, with controlled IDs, viewport clamping, Escape/outside dismissal
  and trigger focus return. Nested popovers stay in their parent's focus
  domain. Phone close icons use IconButton; date and length inputs have a
  visible focus ring.
- Date presets/seasons, custom date drafts and inclusive end-day handling,
  length normalization, draft reseeding and filter serialization are unchanged.
  No API, persistence, URL navigation or shared primitive implementation changes.
- Five retired UI baseline signatures (seven occurrences) are removed. No
  new allowance or exception is introduced. The filter Help article explains
  nonmodal desktop Tab behavior and nested phone Escape ordering.

## Verification

- All five FilterBar test files pass: four existing consumer files plus the
  new overlays file, 33 checks. Supporting filter-context, Help registry/content,
  Popover and Sheet checks also pass. Across both commands this is 107 unique
  checks in 11 suites, with the seven new overlay cases rerun in the second pack.
- Full web types and strict lint of all nine owned source/test files pass.
  Help index generation reports 89 articles and leaves its registry unchanged.
  All 18 UI rule regressions and the complete 1,645-source scan pass: 565 debt
  signatures and 748 occurrences, with no new or stale allowance.
- All twelve actual-source Chromium cases pass with one worker in 13.6 seconds.
  Each case asserts no serious/critical axe findings, page errors or unexpected
  requests. Widths are 360/768/1280 and both themes are explicit. Production
  font readiness is awaited. The already installed Chromium1228 is used;
  no browser install or account/provider/clipboard operation occurs.
- Typecheck first found an unsupported RTL test option, removed without changing
  its string-name matching. The first browser run caught a fixture assertion
  assuming the local end day stayed on the same UTC date. The corrected assertion
  checks the browser's local calendar and 23:59:59.999 boundary. The runtime
  date behavior required no change. Final types and changed browser lint pass.

- Final Next production build passes with the existing validated engine assets
  (`1.6.12`, Windows bundle `fc21ebe5bf52a53c`); no redundant engine prebuild.
  The sandbox attempt could not create its generated `[token]/widget` output
  directory (EPERM). The same source succeeds with reviewed host access.
- All unchanged bundle budgets pass: 18 listed routes and 62 routes under the
  default. Today233.7/240kB, game314.3/440, dossier454.2/500,
  overlay233.8/240, widget317.9/325, Try213.7/240 and Community186/190.

Root reviewed the four runtime consumer diffs and responsive-unmount topology
without a product-source finding. All runtime jobs are closed and the serialized
heavy slot is released. No CI, merge or deployment is claimed.

Seven new consumer unit cases cover nested dismissal/focus, parent Tab
containment, desktop nonmodal behavior, outside pointer focus, date/length
draft semantics and teardown. The older phone test now checks the semantic
parent/child relationship rather than retired positioning class names.

The intercepted browser fixture uses actual FilterBar consumers, shared
primitives, global Tailwind styles and committed fonts. Explicit adapters
provide a synthetic Clerk owner, empty API data, Help anchors and the unrelated
saved-view launcher. Twelve passing cases span both themes and 360/768/1280:
date/length bounds, keyboard ownership, immediate wire filters, outer scrolling,
outside pointer focus and responsive teardown. No account/server or clipboard
access is required. Serious/critical axe findings must fail without exceptions.

Logs are ignored artifacts under `apps/web/.cache/filter-overlays-*`. Browser
captures are in `apps/web/test-results/filter-overlays`. The mobile light date
picker and desktop dark parent capture were visually inspected: text and
controls are legible and contained. Root still owns final review and Git gates.
Do not run the obsolete opponent-section-order temporary script.

The exact twelve-path manifest is `.cache/filter-overlays-owned-paths.txt`;
per-file SHA256 values are `.cache/filter-overlays-source-sha256.json`. These are
ignored local review artifacts. No private game or account observations appear
in this pack.

## Owned paths

Root visually inspected and copied the unchanged synthetic phone Light and
desktop Dark captures into `docs/handoff/screenshots/filter-overlays-fixture-{light-360,dark-1280}.png`
for PR review. No live account or production data is shown.

- `apps/web/components/analyzer/{FilterSheet,MoreFiltersPopover,FilterBar,GameLengthFilter}.tsx`
- `apps/web/components/analyzer/__tests__/FilterBar.{mobileSheet,overlays}.test.tsx`
- `apps/web/tests/e2e/filter-overlays-fixture.mjs`
- `apps/web/tests/e2e/filter-overlays.spec.ts`
- `apps/web/lib/help/articles/analyzer/analyzer-filters.ts`
- `apps/web/scripts/ui-lint/baseline.json`
- `CHANGELOG.md`
- This checkpoint.

Build dossier/editor consumers, chrome/notifications, native confirmations and
copy fallbacks, chart kit, glossary and search remain separate follow-up work.
Pending dossier742/execution748 source and all preserved owner/cache files
are outside this pack.
