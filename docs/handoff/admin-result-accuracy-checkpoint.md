# Admin game result accuracy

2026-10-28. Candidate `codex/admin-result-accuracy`, based on main
`2242d112d9124bca8cfae92d00bc852ccab2f85b`. This is the presentation slice of
original `admin-polish-5`, requirement SHA256
`56099e154cb1d236e3d4bd86299b88bad6534ee7957757d67bec592580dbb483`.
The parent roadmap item remains partial.

## Scope

- The admin detail and both opponent/global-player game lists use one admin
  ResultBadge, backed by the existing canonical `resultLabel` helper. Its
  recorded Win/Victory, Loss/Defeat and Tie/Draw aliases, case and whitespace
  handling remain unchanged. No duplicate result classifier is introduced.
- Ties use the neutral Badge variant. An unknown or missing result displays
  a neutral dash with screen-reader text "Result not recorded". It is no
  longer presented as a loss.
- The existing `?game=`, `?owner=`, `?before=` and other query state, off-page
  detail access, endpoint requests, pagination and selection remain in place.
  No API, stored result, statistics denominator, provider, flag, engine/native
  source, version or asset changes are included.

## Verification

The initial source-only slice passed45 tests/four files, whole-web types and
all six owned TS/TSX lint files. That early two-worker batch is historical.
The accepted main was later integrated locally at `76285591` with runtime
inputs unchanged apart from additive changelog text.

Actual-component browser QA then exposed a real selected desktop Win badge
contrast failure:4.43:1 against the accent row. A narrow opaque surface backing
wraps the existing Badge, retaining its tint, canonical label and shared tokens.
Three existing color assertions traverse that noninteractive wrapper to the
same Badge; no assertion/value/threshold was added, removed or weakened.
The current serialized rerun passes45 cases/four files with one unit worker,
whole-web `--noEmit --incremental false` and strict lint across all six owned
TS/TSX paths with zero errors/warnings. Inputs remain exact before/after.

Direct Next production build `JjIaq_KqIlM3gJQXJ0JlF` passes all83 unchanged
route caps and6863 source inputs before build, after build and after browser
QA. All40 canonical engine inputs, seven active assets and the strict four-game
sample match. Static generation uses one worker and a4GiB heap. No generator,
download, engine/native edit, provider/flag change or asset pruning ran.

The full local matrix passes16 cases: actual opponent/global-player pages at
320/390/768/1280 in both themes. It covers all Win/Loss/Tie/Unknown list and
actual detail badges, native Tab/Enter selection, mobile Back, URL parameter
preservation and global same-game/different-owner selection. All80 full default
Axe scans have zero violations/exclusions;80 geometry states and48 LOCAL
captures pass. The selected Win badge now measures5.02:1 in the actual fresh
compiled styles. All240 product inputs, five CSS files and three fonts are
bound to the completed build. Three LOCAL captures were independently viewed.

Actual pages/detail/query hooks/useApi/SWR are product source. Synthetic Clerk
identity, GET-only data and local Next primitives/history bridge are explicit
seams. This does not prove actual admin authentication/routing, populated chart
data, a provider or live production behavior. No account mutation, diagnostics
Retry or Save is activated. No private production image is copied.

Failed sandbox launch, synthetic Tie fixture metadata, strict binding EEXIST on
worker restart, actual contrast failure and static preparation errors remain
retained. Exact proof equality now permits a repeated binding after a worker
restart, with all mismatches rejected. Final UTC cleanup verifies no owned
process/listener; a PID reused by unrelated installed Chrome was excluded by
its differing executable/creation identity without stopping it. The initial
conservative cleanup record is retained. No assertion, skip or cap was relaxed.

Compact receipts are in
[validation/admin-result-accuracy](validation/admin-result-accuracy/README.md).
All build/browser receipts describe the frozen `76285591` plus two contrast
paths, before evidence-only documentation adoption. Auth807 `df5cf875` merged
afterward; parent must requalify actual overlaps and dependencies before the
next release. Exact final-head CI, deployment and signed-in acceptance remain
pending. No parent-roadmap completion or ledger edit is claimed.

## Remaining original scope

The original item still requires the complete opponent-cohort summary and
decided-only win-rate reconciliation, small-sample hint, shared master/detail
keyboard navigation and polite announcements, URL result/map filters and the
global user filter, plus their API/UI regressions. This narrow accuracy slice
does not satisfy those requirements.
