# Trends charts on demand — source checkpoint

Canonical parent item: `faster-dashboards` (Wave 5), web demand-loading portion.
This pack does not complete the per-user API cache, lighter `/me`, device-auth
cache or local analysis-corpus items. No performance percentage is claimed.

## Source and ownership

Worktree `C:\SC2TOOLS\.worktrees\wave3-my-reviews`, branch
`codex/wave5-trends-demand-loading`, starts at main
`ed484b948456ad81bfc6f367f6d0ea106cfe7d5d`. Root approved the exact 19-path
manifest on October 26. Raw pre-edit files and absent-path records remain in
`.cache/trends-demand-prep-ed484b94/`; the original before-receipt SHA256 is
`e94c97b941eeb072220c75828266103b8024aed2741e7f7e47f6fe530d936604`.
Six eventual screenshot paths are reserved but remain absent until root's
serialized browser proof and image review. No source path expansion is granted.

## Product behavior

The existing summary/Games played and Win rate first row stay immediate.
`DeferredSection` admits the lower charts on approach (the preserved 400px
margin), an explicit Load, or a section jump. It reserves space, falls back to
usable content when observation is missing/unusable, and retains mounted
controls while scrolling. Explorer reuses it and retains the true near-viewport
signal for its existing polling rules; forced activation does not pin that
signal true indefinitely. Existing collapse persistence/unmount semantics stay.

The existing sticky section nav now follows the viewed section. Passive scroll,
resize and size observation only update aria-current. Explicit user jumps alone
open/activate a destination and own heading focus/scroll. Both nav-height and
scroll-spy observation keep the window-resize fallback if construction or
observe fails. Late passive callbacks and retired jump generations cannot
enqueue a new focus action.

The outer Explorer group originally duplicated the real Explorer card's
`trends-explorer-heading`. Its heading now uses
`trends-explorer-section-heading`; the original card ID and `trends-explorer`
section ID remain. A source search for the old heading/hash under apps/web and
docs found only the actual card's aria-labelledby/header and the local group
reference, with no known link consumer. This does not establish what an
external user's bookmark might contain; keeping the original card ID preserves
that target when the card is loaded.

No chart calculation, request path builder, owner scope, filter/context API,
Settings, API/index, infrastructure or budget source changed.

## Authored verification, not executed

Four owned unit/integration suites cover helper admission/identity/fallback,
Explorer viewport/selection behavior, existing layout/hydration contracts and
actual chart/request-hook integration. The new integration suite uses real
charts, FiltersContext, TrendsDataProvider, SWR and clientApi with synthetic
fetch/auth; only native Recharts rendering is stubbed there. Native rendering
belongs to the browser matrix. It includes exact shared matchup GET behavior,
current filters on delayed admission, passive focus/URL boundaries, observer
construction/observe failures, collapsed navigation, global cohort routing and
held-body owner A→B→A retirement.

The browser fixture mounts real Trends and child charts/Recharts, real data
contexts, SWR and clientApi, current production CSS and local fonts. Framework,
auth and unrelated Help/report leaves are explicit adapters. It uses a strict
GET-only loopback host with exact synthetic DTOs; every aggregation request is
logged with owner, real pathname, query, phase and outcome. Static/map-image
resources are counted separately. Unknown/nonlocal requests and all writes are
rejected. Listener/server cleanup has its own receipt.

`compareTrendsDemand` in the fixture is the local paired measurement entry:
run it after the approved build with a browser, identical viewport/theme/mode
and fresh UTC contexts. It verifies and loads only the two exact frozen legacy
product files, then compares them with current source using identical actual
children, hooks, data, CSS, clock, storage and SWR settings. It preserves cold,
filter-before-lower-charts and traversal GET ledgers. Normal CI tests exercise
current source and have no dependency on the cache snapshot. Do not infer
savings from mounted chart count: daily/grouped timeseries differ, and several
chart pairs share an endpoint. Full traversal can perform similar total work.

Browser cases are authored for the existing three viewport projects, both
themes, personal/global views, nav/collapse/scroll boundaries, filter/cohort
changes, retained Inspect window and Explorer drafts, missing observer fallback,
held tokens/bodies, and independent error/Retry. Shared accessibility checks
remain unmodified and establish their existing serious/critical gate only.

## Open validation/delivery state

Source-only authoring is complete and frozen for independent review in
`.cache/trends-demand-source-ed484b94/receipt.json` (13 text paths; the six
reserved screenshot paths remain absent). The exact source bytes are copied
beside that receipt. Any review repair needs a fresh receipt before runtime.
No tests, types, lint, Help/UI generation, build, budget checks, browser, native
app, Git write, network, database, provider or production operation ran in this
source grant. There is no new passing test result, browser image, measured GET
reduction, PR, deployment or production claim. Root owns runtime serialization
after Settings and subsequent Git/integration/delivery. Preserve all original
failures and before bytes; update this checkpoint with exact proof chronology
only after those actions actually occur.
