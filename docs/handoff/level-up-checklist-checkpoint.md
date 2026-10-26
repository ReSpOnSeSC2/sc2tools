# Level-up checklist — source checkpoint

2026-10-26. Branch `codex/wave5-activation`, base
`9a68c480c9d19278642b5c546fe4b3ab081fa6b1`, checkout
`C:\SC2TOOLS\.worktrees\wave4-agent-dashboard`. This is the first slice of the
canonical `level-up-checklist` item. The source and meaningful test cases are
authored. The canonical Help index generator ran once under a limited grant.
The API assertion repair passed the subsequent whole-API typecheck. The first
whole-web typecheck then failed at one unsupported Testing Library test option;
its source-only selector repair below still needs validation. **Tests, lint,
build and browser checks remain unrun for this slice**. The generated Help index
was produced by its script and was not hand edited.

## Behavior

- Today alone mounts the suggestions after at least one game and after the
  existing first-run checklist admits the page. Existing `onboardingView` and
  `useDashboardMe` provide that decision; AnalyzerFrame is unchanged. The leaf
  loads dynamically and does not add a card to analyzer subpages.
- Authenticated `/v1/me/activation` returns six booleans plus normalized goals
  and independent dismissal metadata. The service issues precisely six bounded
  projected `findOne` calls: three users reads, one custom-build read, one games
  existence read and one overlay-token existence read. The final metadata read
  checks that the owner still exists without a GDPR fence. This count excludes
  ordinary HTTP authentication; it is not a constant rows-examined claim.
- Common steps are identity and opening a game. Improve adds custom build and
  confirmed replay check-in; Stream adds an overlay-link connection and enabled
  chat. Improve-only and Stream-only each show four rows; both, empty or invalid
  goals show six. Every row has a real destination and Help link.
- An existing nondeleted custom definition counts even when disabled. Confirmed
  intent must belong to a live, non-pending-delete, non-resumed owner game;
  owner-visible excluded games can count. Historical token activity, including
  a revoked token, counts as a link connection. Chat requires exact boolean
  `true` on one of the four supported platform settings. These checks do not
  claim a verified profile, live broadcast, connected chat or build execution.
- `/v1/me/activation/first-game` accepts one bounded game ID. It verifies the
  exact eligible owned game and uses one guarded, projected, no-upsert users
  command to stamp server time only when the marker is missing or null. Existing
  valid stamps survive concurrent attempts unchanged. The normal authenticated
  write lease covers the route; no nested lease is added. Generic onboarding
  updates cannot write this server-owned marker.
- The actual private GameDetailPage passes its successful current game answer
  to the marker hook. Loading, errors, previous data, mismatched IDs, signed-out
  owners and public pages do not mark. Fresh owner/game/lifetime identities fence
  held JWTs and response bodies across owner A→B→A, game1→game2→game1 and unmount.
  Duplicate conditional HTTP attempts are allowed; the server stamp is write-once.
  No full `/me` or activation GET is added to each game view. Only an already
  existing exact-owner activation cache answer may be patched after an admitted
  ACK; the other five flags are never fabricated.
- Suggestions use owner-keyed SWR with 60-second dedupe and visible refresh.
  Dismissal writes only `levelUpDismissedAt`, and hides only after an admitted
  response confirms the exact issuing stamp. Errors or malformed successful
  responses leave a visible retry. Setup dismissal and all other onboarding
  fields remain independent. Retired owners cannot hide a new card or update
  its cache.
- Completion hides expanded rows and shows “You're all set — see What's new”.
  Only an observed current-owner incomplete→complete transition shows the
  existing accessible toast. Initially complete or dismissed data does not toast.
  Progress follows current saved state and may regress; there is no seventh
  permanent completion flag.

## Scope and preserved work

The approved footprint is 22 paths: six API files, 16 web/content/checkpoint
files including the generated index. No AnalyzerFrame, token manager,
Settings registry, tour registry, native, infrastructure, index, migration,
version or release source is owned. The previous completed Settings Chat branch
and all old caches and temporary scripts remain preserved. The obsolete
opponent-order script must not be executed.

Before raw bytes and absence records are under
`.cache/activation-web-before-9a68c480/before.json` and
`.cache/activation-api-before-9a68c480/before.json`. These caches are not product
or CI dependencies and must not be staged.

## Canonical Help index generation

The parent granted only one installed-Node invocation of
`scripts/gen-help-index.mjs` from `apps/web`. It exited 0 and reported 93 articles;
stderr was empty. The generator added precisely the import and array entry for
`getting-started/your-first-week`, with all other index content equal after LF
normalization. Its canonical writer changed the previous CRLF file to LF.
The other 21 owned source hashes were unchanged during generation. Only this
checkpoint was updated afterward to record the result.

Owned generator PID 37532 closed and was observed absent. The runtime slot was
released immediately. Raw stdout, stderr, before/after index bytes and the
generator receipt are retained under
`.cache/activation-help-index-9a68c480/`. During that generator step, no npm
lifecycle, test, typecheck, lint, build, browser, Git mutation, merge, provider
or production operation occurred.

## First API typecheck and assertion repair

The parent preserved all 22 paths and integrated current main, retaining both
the activation and optional chart-cache dependency wiring and changelog entries.
At `b1aeac69430a5a795673bcb25536fecce91c73bc`, tree
`3a6c92f97595c78b328bf48cb3d7919652e37e5a`, one installed-Node invocation of
`tsc --noEmit --project apps/api/tsconfig.json` exited 2. Its only diagnostic was
TS2493 at `activation.test.js:170`: Jest's Mongo overload inferred a two-element
call tuple, so indexing the actual third options argument was rejected by types.
No product type diagnostic was reported. All 22 source hashes, tool/config pins
and the clean tracked state were unchanged. Owned PID 12956 closed and was
observed absent; the runtime slot was released without a retry.

Before changing the test and this checkpoint, both raw source files and the
first typecheck result were saved under
`.cache/activation-types-tuple-repair-b1aeac69/`. The test now matches the actual
three-argument call with `expect.any(Object)`, `expect.any(Array)` and
`expect.objectContaining` containing the same upsert, returnDocument, deadline
and projection assertions. The exact owner filter assertion, command counts,
real Mongo call and all other assertions remain. No cast, fake service, mock
change or product edit was introduced. Other 20 owned bytes are unchanged.
At that source-only repair freeze, validation was still pending. The subsequent
admitted typecheck below passed; lint, tests, Mongo and browser remain unrun.

## API type retry and first web typecheck

At `6e9a04caf5ace16c41c78d7c7a6fddd0c0cf1e6d`, tree
`64d99c961e253a311bfd0cbae6d3d484b512e76a`, the parent granted a whole-API type
retry and, only after its success and closure, one whole-web typecheck. The API
compiler exited 0 with empty stdout and stderr. Both fresh 22-source and 80
selected-input guards passed. Its driver and compiler closed; a host read-only
probe verified their captured descendants and listeners absent. An earlier
sandbox-denied CIM observation was retained but excluded from closure evidence.

The web compiler then exited 2 with one TS2769 at
`LevelUpChecklist.test.tsx:125`: Testing Library's `findByRole` does not accept
the `exact` property used by Playwright. No product type diagnostic was reported.
Both guards passed again. Its captured driver/compiler descendants and listeners
were verified absent, and the runtime slot was released without repair or retry.
Raw results and closures remain under
`.cache/activation-validation-prep-6e9a04ca/`; the compact types summary records
the actual API0 and web2 separately.

Before changing this checkpoint and the one test selector, both source files
and the actual type results were preserved under
`.cache/activation-web-type-repair-6e9a04ca/`. The selector now uses the anchored
`/^Retry$/` accessible-name matcher. Every retry, error, data and write assertion
remains unchanged. Other 20 owned source bytes, all API source/type inputs and
tool/config pins are unchanged, so the actual API0 is retained. The web type
retry remains pending. No runtime, lint, test, Mongo, build, browser, generator
or Git operation accompanied this source-only repair.

## Browser held-body proof strengthening

Source review found that the synthetic response parsed JSON only after its hold
was released, allowing native fetch cancellation to reject the parse before a
stale decoded answer reached the consumer. The fixture now decodes and captures
the real response first, then records the held event and installs its gate in
the same synchronous continuation. Releasing the gate returns that captured DTO
even after abort. Existing assertions therefore wait for a decoded held answer;
HTTP, signals and product code are unchanged. This is a source-only test repair,
not a browser or validation pass. Both prior files were preserved under
`.cache/activation-decoded-body-repair-8dd73509/` before the edit.

## Validation still required

New source-only tests cover real Mongo flags, exact six-read shape/projections,
privacy, deadlines, historical activity, malformed dates, owner erasure and
fences, actual no-confirmation query cost, concurrent first-view stamps, route
ownership and independent preference merges. Web cases exercise the pure 4/4/6
mapping, real owner-scoped request code, held JWT/body retirement, record changes,
StrictMode, loading/error admission, dismissal ACK validation, completion
transitions and the actual Today/GameDetail integration seams. Browser source
uses actual components with synthetic local transport and framework/auth
boundaries, production CSS/fonts, full shared accessibility checks and owned
listener cleanup. These are planned cases, not passing results.

After source review and preservation, run targeted meaningful API/web tests,
types and strict changed-source lint with the parent's serialized runtime rules.
The Help generator is complete; its registry/content checks remain unrun.
Then perform the production build, unchanged bundle
budgets and actual browser/visual verification. Integrate fresh main, resolve
shared app/changelog content normally, and require exact-head CI before merging.
The absence check can scan owner history despite one bounded command; do not
weaken it to a recent-games cap or claim measured constant cost. No production
migration, provider activation, publishing, model feature or new infrastructure
is included.

Guided tours remain a separate dependent item. There is no placeholder button,
empty registry, fake tour flag or automatic focus/scroll change in this slice.
