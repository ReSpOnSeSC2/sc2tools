# Saved opponent detail columns

Branch: `codex/expand-opponent-columns`.
Validated runtime source: `572cccb17e8b7f79318e18ad06b359ad8702335b`.
Includes current main `296f39c6`, preference fixes `0fa62e8d`/`4bfedd2f`,
download fence `8bcc0e55`, API summaries `677d9591`, cutover correction
`ddf09bbf`, and scouting-control dependency #753 at `837841d2`.

## Implemented

- Nineteen optional choices: the original five rating/ID fields plus region,
  latest replay download/result/length/map, your build/opponent build,
  opponent build-order link/date, your macro breakdown/leaks, measured game
  length/macro averages and scouting notes. Desktop table and phone detail
  cards share the new choices. The dossier section order is unchanged.
- Explicit preference writes are synchronous; hydration never persists the
  first default render. Sort restoration and passive URL/Back updates do not
  overwrite the saved sort. Column defaults/reset remain compatible.
- Picker options save automatically in this browser, survive fresh sessions,
  and stay in the available viewport above/below their anchor. Resize/scroll
  positioning reserves the existing mobile navigation inset. Escape restores
  summary focus. A positioned table scroller contains absolute screen-reader
  status nodes as well as the wide visible table.
- `listDetails=1` is opt-in for data columns or their sort; region/notes alone
  add no summary work. Existing page-scoped batch reads provide bounded
  scalar values, full-cohort measured sums/counts, and at most 25 metadata
  candidates per opponent/5,000 per page. No R2 reads, GET writes, new request
  per row, new index or production backfill. Queries have 5-second bounds;
  the default list path is unchanged. Responses are private/no-store.
- Actual opponent logs produce compact facts beside their detail blobs;
  Mongo writes are atomic and R2 uses its existing ETag/revision fence.
  Complete coverage requires the active backend to be confirmed Mongo, every
  source fact valid, and the entire cohort in the bounded window. R2, unknown
  backends, cutover failures, legacy rows and incomplete windows remain
  unknown. Positive partial dates say Latest known and offer inspection.
  Classifier labels never establish a log/date. Opaque game IDs stay exact.
- Grouped means combine sums/counts; zero differs from unknown. Each game
  link carries the actual account that supplied that game/order, even when
  the group heading uses another account. Existing game/list context is kept.
- Latest replay means **download the latest replay**, as clarified by the
  owner. Existing download routes run only after a click. Owner/game/path/
  filename/availability ABA fences, unmount cancellation and 20-second waits
  prevent stale delivery/toasts. No token or signed URL is fetched to render
  the replay column. CSV includes scalar values, with formula escaping,
  without signed URLs or full logs.

## Validation

- API: 238 passing checks across 13 focused suites, including real Mongo
  owner/filter/query tests and ingest/reanalysis/overlap races. Both first
  Mongo-to-R2 metadata-failure directions reproduced false known coverage
  before the correction and pass afterward. API types and strict new-helper
  lint pass; existing large files retain their scoped warning baseline.
- Real metadata lookup explain uses `userId_1_gameId_1`, zero collection
  scans, three documents/four keys examined for four candidates. Actual Mongo
  stress confirms bounded max-page facets can exceed 16 MiB internally but
  remain below 100 MiB and unwind into individually bounded results.
- Web focused packs cover storage/StrictMode/SSR, URL precedence, actual
  column controls/query/sort/CSV, weighted aliases, zero/unknown/date facts,
  account-correct links and download consumers. Download pack: 83 checks;
  later cell regression adds the grouped carrier case. Final picker/table
  pack: 32 checks. Additional focused core suites cover grouping, navigation
  and summary helpers, overlapping the checks above. No full
  local web/API suite claim is made; remote exact-head suites are required.
- Final production build/typecheck and unchanged budgets pass. Browser
  engine `25b300818c31d41b`, 1.6.12/Python 3.14.2, rebuilt/smoke-checked.
  Today 238.7/240 kB, opponents 120.5/180, dossier 451.6/500,
  overlay 239.7/240, widget 323.8/325; every listed/default route passes.
  Initial filesystem-blocked build was retried with local output permissions.
- Real browser matrix: **459 checks**, 320/390/768/1440 in light/dark,
  actual components/hooks/production CSS, synthetic auth/API boundaries.
  Fresh-context preferences/reset, alias means/carrier links, sort/Back,
  private scalar CSV, exactly eight mocked explicit downloads, no eager
  replay request/JWT, delayed refresh position/focus and table containment.
  Picker bounds/Reset pass after restore, height 1000→700→1000, navigation
  reserve and outer scrolling. No page errors, unexpected/external requests
  or mutations. Prior desktop overflow was reproduced before its correction.
- Root inspected final phone pickers and desktop left/right captures in both
  themes. Four representative owned captures are checked in; all 20 final
  captures and JSON evidence remain in `.cache/opponent-columns`.
- Independent reviews found and verified corrections for stale downloads,
  account context, picker/table containment and storage-cutover coverage;
  no remaining source blocker was reported.
- Exact-head CI caught two old download-consumer mocks missing the real owner
  scope export. Corrected the accounts-source unit fixture and coaching browser
  fixture, plus the same latent omission (and bounded request helper) in two
  existing manual game fixtures. Runtime source was unchanged. The focused
  consumer pack passed 111 tests across seven suites, coaching passed all nine
  browser cases at 360/768/1280, and both manual bundles compiled successfully.

## Integration / remaining gates

#753 merged after its corrected exact head passed every check. The column PR
is now reconciled with that main and targets main directly. Verify its fresh
head's merge tree and remote checks after the test-only mock corrections. #750 is included;
close it as superseded only after the combined preference/columns work merges.
No migration, real download, provider write, release, installer execution,
version bump or tag occurred. Older unindexed build-order dates remain
unknown; this change does not scan historical R2 blobs to invent coverage.

When later integrating navigation #731, preserve passive `persist:false`
sort updates and add the detail sort keys to its global query whitelist.
