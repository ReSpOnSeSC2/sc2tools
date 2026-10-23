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

- API:58 tests/2suites; full API types passed before final main integration.
- Web:210 assertions/34actual consumer/formatter suites pass. Full types and strict changed-file lint pass.
- Exact CI env production build and all unchanged budgets pass at the earlier implementation: landing213.4/215, app235.1/240, game313.1/440, opponent487.5/500, guide171.7/175, community182.4/190kB. Final source/integration build remains required before PR.
-39 real component browser checks at390/768/1440 with production CSS: prior supply/filtering, aligned scrolling/rows (also after clipboard denial), copy text/Markdown, rules-only output, real CSV/JSON downloads, one-page PDF print capture, no overflow or JS errors. Synthetic auth/API/Next boundaries; no live account tests or production writes.
- Reproduce after a production build from apps/web: `node tests/manual/build-exports.cjs`. It writes ignored .tmp fixtures/downloads/PDFs and screenshot evidence. Playwright Chromium must be available. Print-dialog invocation is captured locally and its actual HTML/CSS is rendered to PDF; this does not exercise a physical printer.
- Screenshots: `docs/handoff/screenshots/build-exports-390.png`, `build-exports-1440.png`, and matching print captures. Final docs/tests/build/root integration and remote CI still pending; this file is a progress checkpoint, not a completion claim.
