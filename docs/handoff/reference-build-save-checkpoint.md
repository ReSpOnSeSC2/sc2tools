# Reference build save correction — 2026-10-27

Branch: `codex/reference-build-save`, based on main
`f3e27b85815621dfb8ff10659370865a54dad261`. Sessions History work remains
preserved separately in the dock-series-ci worktree.

## Behavior

A valid source-created build could not be saved because its private
`buildOrder.sourceGameId` contains the timestamp/player/map separators used by
real replay IDs. The former token regex rejected those IDs and displayed a
generic reference-field error. Web and API now accept the same nonblank,
single-line opaque ID, bounded to 256 Unicode code points. Controls and all
existing step bounds remain rejected. Identities are preserved exactly in
owner detail and excluded from public Community projections.

The editor reports the first invalid step and field. Review build order opens
and visibly focuses that tab, including from a scrolled rules panel. Supply
and note labels are explicitly linked to their controls. Unknown reference
actions remain valid; classifier tokens and rule meanings are unchanged.

The “8 gate” warning describes a missing Gateway requirement in the rules,
not zero Gateways in the source replay. It was already advisory and dismissible.
Dismissal does not bypass a separate invalid reference field.

Detailed diagnostics live in `buildOrderReferenceErrors.ts`, sharing the
compact reader's scalar predicates. Public reference displays and the common
`build-rules.ts` do not import that diagnostic module. No budget was raised.

## Local verification

Evidence: `C:\SC2TOOLS\.cache\reference-build-save-verification-20261027`.

- `web-final-validation-04`: whole-web types, strict scoped lint and 104 tests
  in 8 files passed. Repeated earlier runs overlap; do not add their counts.
- `api-tests-01`: 29 tests in 2 files passed, including actual authenticated
  save/read, foreign-owner 404 and public/private publication boundaries.
  `api-control-baseline-01` adds four trailing-line-terminator cases and passes
  all 29 validator tests. Together these represent 33 distinct API tests,
  including the four service-boundary tests from the earlier run.
- `api-final-validation-01`: whole-API types and strict scoped lint passed.
- Own Next production build 04: `-3G1xLP7lZDO5g0AVyyUN`. Postbuild 06 passes
  all 81 original route budgets (18 listed, 63 default). `/app` is 238.2/240 kB;
  Community is 190/190 kB under the checker’s unrounded limit.
- Help index regeneration retains 96 articles and no Git diff. A first write
  normalized only CRLF to LF; reconstruction of the original CRLF bytes
  exactly matches the prior hash. A subsequent regeneration is byte-stable.
- Browser 02: four complete cases at 390×1000 and 1280×720, light and dark.
  Actual editor, saved-build launcher, SWR, HTTP transport and API validators
  cover source fill, advisory dismissal, invalid-time recovery, explicit focus,
  save/read/reopen and a separate Save & re-match request. Eight local PUTs,
  four expected foreign reads returning 404, no external requests, page errors,
  console errors, request failures or unexpected server routes.
- Twenty full raw axe AA scans: zero violations; 16 nodes were incomplete
  because axe's contrast grid could not measure clipped Basics/name/description/
  privacy content. Root reviewed the rendered palettes and screenshots.
  This is not product-wide accessibility certification.
- Root reviewed the four committed phone/desktop captures in both themes.
  Explicit Review focus is fully inside the actual scrollport before a field
  locator can scroll on the test's behalf.
- Browser/server/socket closure is recorded; all 19 observed browser-group
  identities retired with no owned listener. Other serial groups have their
  own positive closure receipts.
- Forty canonical/raw engine sources, seven active shared assets, the committed
  sample and the original three junction targets remain unchanged. The added
  API dependency junction points only to the existing installed dependencies.
- `final-local-review-01.json` proves production inputs stayed identical after
  build 04. Only two manual harness files and extra API tests changed afterward.

## Retained failed or superseded evidence

Initial consumer tests used a count on a `before` rule, then an unsupported
`count_before` fixture and an incorrectly shaped preview mock. Correcting the
fixtures to the existing `count_min` contract and real preview shape resolved
them. No product rule semantics were changed to satisfy the tests.

An early pinned typecheck was invalidated by a concurrent focus edit and is not
claimed as final verification. Scoped lint initially found two existing label
association warnings; explicit control IDs resolve them. Final checks are clean.

Postbuild 01 used the wrong Help index path and stopped before starting Node.
Builds 01/02 compiled but failed Community's original budget at 190.3/190 and
190.5/190 kB. The diagnostic boundary was repaired rather than raising limits.
Postbuild 04 retained the CRLF-only index normalization failure; postbuilds
05/06 pass. Build 04 follows the final small diagnostic-function extraction.

Browser 01 passed both phone cases, then correctly failed its requirement for
positive scroll in a desktop window where the form naturally fit. Browser 02
uses a shorter desktop window to retain that strict scroll/focus assertion.
Manual socket teardown now awaits close events before recording an empty set.
All prior artifacts remain intact; no test is skipped and no retry hides a run.

## Delivery and limits

At this checkpoint commit, PR CI and coordinated production deployment remain
pending. Verify exact-head web/API/browser checks and deployment source/domain
before reporting the fix live; retain those receipts alongside local evidence.

The browser fixture substitutes auth/Next/Sentry boundaries and uses disposable
loopback storage. Actual API validators run, while Express/Mongo service behavior
is covered separately by boundary tests. The queued fixture response proves the
re-match request field; it does not execute a background classification job.

No migration, infrastructure, provider activation, environment variable,
schema-version bump, agent version or release tag is required. Deploy web and
API together. A coordinated code revert rolls back; opaque provenance remains
private. An old strict reader can again refuse editing a composite ID after
rollback, without changing or losing stored reference steps.
