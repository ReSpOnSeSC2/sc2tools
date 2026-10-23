# Build supply and exports

Scope: Wave3 `build-order-supply-export`, including both augments. No AI feature/API call, production operation, migration, service, environment setting or budget increase.

## Implementation

- API enriches display events after start-time conversion, using last finite nonnegative food_used at/before that time. Own/opponent full/early arrays use their own stats; exact supply wins, missing/pre-sample values stay unknown. Events are cloned. Existing detail read adds macroBreakdown to its projection, with no second database read. Classifier raw/completion times stay unchanged.
- Owner Builds has a Supply column, worker/supply/text filters and row-seek clock integration. Wide columns align time slots and scroll together. Grouping/filter normalization is memoized independently of the clock. Public/review defaults stay optional.
- Each column exports visible steps to text/supply-first/Markdown/SALT, prints the first60 chronological steps, and retains the existing confirmed Ghost/Undo and actual custom editor. Opponent actions use the reversed concrete matchup; source-game self-grading guard remains.
- Game header creates local Blob downloads for available stats/casualty CSV and schemaVersion1 JSON. Missing measurements remain blank; missing datasets disable only their relevant export. CSV quotes names and escapes spreadsheet-formula text.
- Custom and Community menus prefer v3 condition text over obsolete signatures. Signatures disclose their deadline semantics and retain counts. No private notes are copied. Blocks include title/matchup/author-or-Anonymous/absolute source; SALT uses the existing format's metadata fields and reports skipped items inline.
- Clipboard-denied fallback is selected/focused and dismissible. Feedback floats below the menu so it cannot change header/row alignment; real browser checks caught and fixed the original shift. Reopening actions clears prior feedback so it cannot intercept clicks. Print hides other body roots through the local print portal and stylesheet.
- Help `build-orders-export`, Community help line, generated index, CHANGELOG and owner setup notes updated.

## Validation so far

- API:59tests/2suites and full API types pass after main72b345d0 integration, including the Archon completion regression.
- Web:213 assertions/34actual consumer/formatter suites pass. Another99Help/Ghost/formatter checks pass (counts overlap). Full types and strict changed-file lint pass.
- Final reviewed feature source: exact CI env production build and all unchanged budgets pass: landing213.4/215, app235.1/240, game313.1/440, opponent487.5/500, guide171.7/175, community182.4/190kB.
-65 real component browser checks at320/390/768/1440 with production CSS: prior supply/filtering, aligned scrolling/rows (also after clipboard denial), copy text/Markdown, deferred permission denial after dismissal without focus theft, rules-only and actual Community toolbar exports, real CSV/JSON downloads, one-page PDF print capture, actual Ghost replacement/Undo and the real Save-as-new-build editor. No overflow or JS errors. Synthetic auth/API/Next boundaries; no live account tests or production writes.
- Reproduce after a production build from apps/web: `node tests/manual/build-exports.cjs`. It writes ignored .tmp fixtures/downloads/PDFs and screenshot evidence. Playwright Chromium must be available. Print-dialog invocation is captured locally and its actual HTML/CSS is rendered to PDF; this does not exercise a physical printer.
- Screenshots: `docs/handoff/screenshots/build-exports-390.png`, `build-exports-1440.png`, and matching print captures. Independent review found canonical worker/depot filtering and delayed clipboard focus races; both are repaired with regression tests. Final main integration and exact-head remote CI remain required before merge.
