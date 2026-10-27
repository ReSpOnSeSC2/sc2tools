# Sessions core PR A — local delivery checkpoint

2026-10-27. Implemented on `codex/sessions-core`, based on merged main
`f99c66efb112135c1e09db4ffbd6c1839e3d5af8`. Final API/web groups, build05 and
all 24 browser cases passed. Root reviewed normal phone Profile, native widget
and toast captures in both palettes. Independent final audit05 is CLEAR; exact-head
CI/PR delivery remains pending. Session-history PR B and the wider program remain
open.

## Contract and scope

Profile accepts integer 15–480 minutes or null for Auto; omitted legacy PUT
fields preserve the preference. Auto uses 240 minutes with any stored
overlay-token record, including revoked/rotation-pending, otherwise 90.
Live/overlay aggregates, personal momentum and both session quizzes share the
policy while keeping their existing game universes. Global momentum retains its
independent partitions and 90-minute/analysis override; calendar-day dashboard
totals keep their scope. Today retains 14-day candidates, future exclusion,
inclusive manual anchor, region handling and MMR fallbacks.

Stored replay-END gaps split only when strictly greater. Equality, midnight and
DST stay connected. Eligible unknown outcomes bridge before decided statistics;
deterministic supported-scalar ordering retains duplicate multiplicity. Mongo
keeps indexed bounds, then scalar BSON Date before ordering/arithmetic, without
legacy array/string/number rescue scans.

The tiny authenticated no-store policy read requires positive current owner/read
admission before a warm value seeds a quiz. Unavailable policy has Retry. Pending
Profile edits stay local; only an admitted PUT ACK publishes shared cache state.
Owner/form/request guards retire held tokens/bodies and A→B→A work. Failed saves
retain retryable drafts; advisory cache failure cannot falsify confirmed success
or cause a second GET. Daily answers remain independent through the actual Today
picker/runner graph.

Bounded process-local gates/generations fence resolution and final HTTP 200/304
or private emits, including cache-OFF. Known policy retirement after a committed
GameDesk reset drops stale optional fanout while preserving its ACK; unrelated
errors still fail. Tours atomic writes, Device finalizers and ETag guards remain
intact. No migration, new index, unbounded cache, external service, flag activation
or agent release is required. Overlay gap text includes zero-game/legacy output;
canonical Help has 96 articles. See [ADR 0067](../adr/0067-session-policy.md).

## Current local evidence

Raw logs, immutable bindings and owned-process closure are under
`.cache/sessions-verification-20261027/`. Counts are targeted, not full CI;
earlier overlapping runs are not added as unique coverage.

| Gate | Recorded result |
| --- | --- |
| API final selected01 | 480 tests / 30 suites PASS, 33.37s; 31 identities closed. Product API unchanged afterward; stale test comment corrected |
| Web final selected02 | 349 tests / 29 files PASS after label change, 18.64s; 36 identities closed, 0 listeners |
| Types / lint | Whole API and web/browser-fixture types passed. Strict changed-web lint: 0 warnings/errors. API: 38 verified inherited warnings, 0 errors; strict exit remains nonzero, no added warning/waiver |
| Build05 | `Rqg3HdzLCLx1uWo7SW82w`, 149 pages PASS; 11 identities closed |
| Budgets06 / assets r5 | All 81 unchanged caps PASS. Pre/post-build and post-browser checks: 40 canonical sources / 7 active files / 4 strict sample games unchanged; 3 identities closed per check |
| Browser05 | 24 passed, 0 skipped/retried/flaky, 133.628s; 192 identities closed, 0 listeners |
| Extraction05 | 96 full AA scans, 0 violations; 36 incomplete contrast observations: 32 gradient-widget states and 4 partially obscured invalid toasts |
| Root visual review | Phone Profile, all 8 native widget PNGs (4 states × 2 palettes, 1264×1196), and 4 toast captures clear/readable |
| Independent source/evidence audit05 | CLEAR; expected held PUT aborts and intentional unavailable responses classified, 0 unknown exchanges |
| Exact-head CI / PR / production verification | **PENDING** |

Current `final-sessions-06` snapshot: 3107 pins, SHA256
`141f2f29a5421e7c035c95debda7c377f5b113d86b0483ab3ea3aad696542598`.
Extraction05 summary SHA256:
`7584748dc1a599fde00d5b121d34160fbcf021699b6478731c64ae5622b3dc32`
(186 files, 28 wire and 44 native receipts). Root visual receipt SHA256:
c1a31e4096b36c1b36fbae82fdb40a2b1df30802bed4a1ffce7e3265bb43ef06.
Canonical Help generation passed;
second output was byte-identical.

The real Settings/policy/clientApi/SWR, ModeRunner and SessionWidget matrix uses
synthetic owners/API data with actual `data-theme`/background identity. Normal
widths are phone 390 and desktop 1280 CSS pixels. S06 widget states additionally
use new owned persistent desktop contexts at native 200%: physical 1280×900,
632 CSS pixels, DPR 2, visual scale 1. The CDP capture repair changes only the
test helper; zoom, CSS and AA gates are unchanged. No phone 195px or
prior-context continuity proof is claimed. Audit05 confirms all 16 native capture
pixel/layout records at 1264×1196 and 4 native contexts closed. Browser04's
cropped native PNGs remain historical; browser05 supplies complete captures.

The final SESSION label opacity changes .6→.85. Static math bounds contrast at
5.742:1 over the unchanged default gradient on any backdrop. Toast text is
readable, but notifications temporarily overlap SaveBar/fields; dismiss then
Retry passes. All 36 incomplete AA observations remain raw and unresolved.
Neither static math nor zero automated violations certifies the whole product.

## Real Mongo observations and limits

Explain02 passed four actual buildApp/Games/Aggregations cases on 80 synthetic
games (16 owned, 64 other-owner), with 6 identities closed, provider/network counts
0 and no app HTTP listener. All winning plans used `userId_1_date_-1` IXSCAN.
Today baseline/anchor each examined 11 documents/11 keys and fetched 6 candidates;
the anchored result includes the exact anchor. Bounded momentum examined 11/11
with cursor 4 (diagnostic prefix 5→4); all-time examined 12/12 with cursor 7
(8→7). No hints or fixture indexes were added. API raw pins stayed unchanged
through later UI work. These observations establish neither production cost/
speedup nor universal legacy BSON/JSON or distributed writer coherence.

Original drafts/seals and first RED receipts remain preserved, including the
anonymous-Field and speculative-cache A→B→A failures. Final Profile uses
confirmed ACK publication, labelled fields and 44px Save controls; DailyEmptyState
uses readable white/teal text. Finish pending exact-head CI/delivery from actual
receipts, retaining incomplete observations and owned process/listener closure.

## Reviewed screenshots

These are synthetic real-component harness captures using the current production
CSS and committed fonts, not the full application shell or production accounts.
Phone Profile uses normal 390 CSS pixels. Widget captures use native desktop
200% at 632 CSS pixels; the PNGs contain 1264×1196 physical pixels.

| State | Light | Dark |
| --- | --- | --- |
| Profile saved 45 minutes | [Phone](screenshots/sessions-profile-light-390.png) | [Phone](screenshots/sessions-profile-dark-390.png) |
| Zero games, explicit 45 | [Widget](screenshots/sessions-widget-cloud45-light-native200.png) | [Widget](screenshots/sessions-widget-cloud45-dark-native200.png) |
| Zero games, Auto 90 | [Widget](screenshots/sessions-widget-auto90-light-native200.png) | [Widget](screenshots/sessions-widget-auto90-dark-native200.png) |
| Active, Auto 240 | [Widget](screenshots/sessions-widget-active240-light-native200.png) | [Widget](screenshots/sessions-widget-active240-dark-native200.png) |
| Legacy payload | [Widget](screenshots/sessions-widget-legacy-light-native200.png) | [Widget](screenshots/sessions-widget-legacy-dark-native200.png) |
