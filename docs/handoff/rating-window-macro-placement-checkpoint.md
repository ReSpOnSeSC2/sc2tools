# Rating inspection and Macro Breakdown placement

User-requested website fixes, based on main `8d7ec51d` and integrated at `7ff218cd`.

- Move the existing private Macro Breakdown build selector after the body, below What you did well and before the footer. Loading/error states retain the selector. No editor behavior, callback, scoring or native agent changes.
- Inspect window selects a rolling estimate ending at the chosen game. Add an index-position cursor, a ring around finite selected points, and a politely announced game range, ending date, estimate and coverage. Keep the full-sample headline, request, rating calculations, point order, domains and missing/unbounded gaps unchanged.
- Original indices distinguish duplicate dates and equal rounded estimates. Null windows have a cursor when a chart exists, no invented finite point, and explicit coverage. Entirely null series retain the existing empty-line explanation.

Validation:

- 67 focused checks across nine suites: rating consumer, pure sparkline, Macro panel placement/patch era, both build-selector suites and Help. The DOM-order regression uses the real macro body and proves feedback → Change build → footer Recompute.
- Current integrated source passes full web TypeScript, strict lint on six changed TypeScript files, all 19 UI rules and the 1,671-file scan with 656 inherited occurrences and no allowance changes.
- Two actual-component Chromium tests pass across Light/Dark at 320, 390, 768 and 1440px: keyboard selection/focus, duplicate dates and equal estimates, finite/null/entirely null windows, cursor/ring, unchanged paths/headline, no horizontal overflow, and full serious/critical WCAG AA checks including contrast. All browser requests are intercepted; no real account, replay or external write is involved.
- Reviewed synthetic captures: `screenshots/rating-window-light-320.png` and `screenshots/rating-window-dark-1440.png`. Raw browser artifacts and logs stay in the ignored `.cache/inspection-window-*` paths.
- Current integrated production build passes all 81 unchanged route checks: 18 explicit and 63 default checks (including Community 188.4/190 kB, Guides 172.8/175, Today 233.9/240 and opponent dossier 458.7/500). Existing unrelated whole-file size warnings remain unchanged. Remote CI passed with 8,730 web tests and 369 responsive/browser checks; the fixes merged as `1c3d9877`. Deployment verification is recorded on PR 761.

No version bump, tag, replay recomputation, new dependency or API change is required.
