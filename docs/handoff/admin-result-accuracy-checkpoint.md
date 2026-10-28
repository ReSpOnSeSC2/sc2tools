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

Source preparation includes canonical alias/unknown/variant regressions,
actual AdminGameDetail result rendering, and both actual list components with
URL/owner selection assertions. Existing off-page selection and missing-game
assertions are retained. The chart/data boundaries in the new component tests
are explicit mocks; no real replay or API behavior is inferred.

The serialized local run passed 45 tests in four files with no skips, including
all three original off-page/missing-game selection cases. Whole-web types passed
with `--noEmit --incremental false`; all six owned TS/TSX files have zero lint
errors or warnings, with zero warnings in their original preimages too. New
files also passed strict lint. Unit workers were capped at two. The nine owned
source/documentation inputs and four protected inputs matched before/after
these checks. This paragraph was updated afterward; runtime source is unchanged.
Owned process/listener cleanup found zero candidates and stopped nothing. No
browser, Mongo or production build was started.

Local receipts and preimages are retained in
`.cache/admin-result-accuracy-20261028`. Production build, all 83 unchanged route
budgets, responsive/accessibility checks, independent source review, exact-head
CI and actual delivery remain pending. No completion or production acceptance
is claimed here.

## Remaining original scope

The original item still requires the complete opponent-cohort summary and
decided-only win-rate reconciliation, small-sample hint, shared master/detail
keyboard navigation and polite announcements, URL result/map filters and the
global user filter, plus their API/UI regressions. This narrow accuracy slice
does not satisfy those requirements.
