# Build dossier insights checkpoint

Branch: `codex/wave4-build-dossier-insights`. ADR0057 owns the bounded design.

The queued combined Scorecard branch at `53aa5356` has a source-only runner
repair pending normal current-main/Public integration. Dossier fresh captures
default to `.cache/build-dossier-insights-current-evidence`, optionally selected
with `DOSSIER_EVIDENCE_DIR`. Pinned Chromium, startup cleanup, theme-before-mount
storage/HTML and resolved palette assertions are authored. Full-page checks
call main's shared AA helper instead of disabling contrast; no allowlist or
product/API source is changed. Original screenshot hashes and the four-file
manifest are recorded in `.cache/build-evidence-original-shots-sha256.json`
and `.cache/build-evidence-runner-owned-paths.txt`. No generator, test, browser
or build has run for this repair. Earlier results below remain historical;
current engine and AA proof must follow the eventual integrated source.

The API reuses complete owner/visibility-scoped performance aggregations, adds
confirmed declared-plan facets, and hydrates at most the latest 25 selected
timing logs through the shared split-store reader. Hidden, deleted, pending,
resumed and foreign-owner rows do not enter those cohorts. Unapplied check-ins
whose declared reference differs from the effective build cannot inflate a
different build's plan denominator.

Plan labels retain full counts, at most five ranked labels and at most twenty
latest sample IDs per label for exact owner-only game links. Missing detection
means no different label was recorded. Median duration is an approximate full
game duration, not the time or cause of a plan change.

Community timings use one bounded indexed snapshot batch. Exact catalog
identity, current guide era, publication floors and equivalent first-start
milestones are required. Private same-name classifiers, mixed/unknown eras,
morph completion and later occurrences do not produce comparisons. Winner and
loser medians use the same personal samples and require five of each outcome.
Timing recency sorts actual timestamps; unknown dates retain quantiles while
withholding trends and last-seen claims.

API verification: the initial 149 tests across ten suites and one snapshot,
then 68 compactor/outcome and 62 library/cohort regressions, full API type
checking and strict helper/test lint pass. The bounded compactor now preserves
earliest construction-start parity on unordered logs, including morphs. Timing
win rate uses decided games with an explicit denominator. Library Held summaries
reuse the same existing grouped query and visibility guards, with no hydration.

Key timings and Plan survival cards, optional native section links and selected
sample-game integration are implemented. An owner/auth epoch prevents selections
from resurfacing across loading/signout/ABA transitions. The owned game page uses
one exact loaded-intent dossier SWR key for all first-occurrence owner building
deltas; old cohorts, failed cached lookups and unidentified/deleted references
supply no baseline. Existing supply, actions and shared-clock seeking stay intact.
The cards remain inside the existing lazy dossier route/modal boundaries; the
game comparison remains in the existing lazy build-order chunk.

New card/helper/wrapper consumers, the existing game consumers and owner-scoped
dossier integration/nav tests pass. The final affected web set is 111 tests,
including the owner game page, Held sorting and visible-cohort CSV. Full types/scoped
lint pass. Combined API 153 tests/ten suites + one snapshot and all 145 custom-build
service regressions pass. Independent review cleared the final API additions.

The approved seven-minute cutoff dependency `3dceab1c` was integrated at `2a4c5689`.
Actual main `e2fa5d08` has a clean merge tree identical to that HEAD tree; no extra
bookkeeping merge is needed. Required engine `25b300818c31d41b` builds/smokes
successfully. The production Next baseline passes every unchanged budget:
landing 214.9/215, Today 239.1/240, game 312.7/440, Builds 197/270,
opponent 471.7/500, Dock 215.3/225, AIO 238.3/240, widget 322.5/325,
guide 168.7/175 kB. It uses the public nonfunctional example Clerk key from CI.

The actual-source loopback browser matrix passes 189 checks with 32 captures at
320/390/768/1440 in both themes using production CSS/fonts. It covers keyboard
selection/focus, exact example links, matchup/source changes, small samples,
owner loading/B/A, clock seeking, Held summaries/sort/search, overflow/targets and axe. No external traffic
or writes are allowed. Captures live under `.cache/build-dossier-insights-evidence`;
fixed/sticky page chrome is hidden only for element screenshots so it does not
obscure a stitched card. Heading order and fully visible mobile delta text were
corrected from the browser evidence; both timeline columns retain equal slots.

Selected examples now carry sampled navigation, requiring the existing explicit
broader-scope opt-in before Older/Newer. Optional nav removal resets its active
anchor. The final production/browser pass includes Held summaries in the card
and table. Actual #738 reconciliation proved BuildCard, types and BuildsTab
unchanged there; this pack never edits its overlapping editor or library files.
The Held field remains additive beside future Reference fields. A peer caught a
valid legacy private-slug alphabet mismatch; the game resource now accepts its
existing bounded case/underscore/dot alphabet and has a regression.

Actual selected and logged timing counts are separate from the 25-game cap,
including the case of 30 performance games with only five eligible timings.
Help, ADR, changelog and owner notes are written. Actual main #741 at
`59633bfe` is integrated at `2102fa1c`; the two additive changelog/setup conflicts
retain both packs. App wiring differs from main only by injecting the existing
game-details reader into BuildsService. Engine/native files are absent from the
feature diff. Combined service wiring/readers pass 44 tests and one snapshot,
with full API types. The final integrated production build/budgets and browser
matrix pass. The catalog/library aggregation test also verifies the same Held
floor end to end, including zero and small samples, with no hydration.

Eight representative light-phone/dark-desktop captures are committed under
`docs/handoff/screenshots/build-dossier-*`. Complete captures/call receipts remain
in the local evidence folder. Independent API review is clear; full UI/visual
review and expected-head GitHub/Vercel gates are tracked in the attached PR.

Peer UI review confirmed a no-output cost edge: a valid intent could fetch a
dossier even when own build events were missing, loading, failed or unextracted.
The wrapper now gates both its resource path and any warm baseline in those
states. Seven wrapper and six timeline consumers pass; the expanded local
browser matrix passes 197 checks/32 captures and proves zero extra baseline
reads for absent own logs. All other UI/sample/first-occurrence/count shaping
was independently reviewed without another blocker. The inherited shared-useApi
JWT fence is being repaired separately; integrate its reviewed source before
the next combined production/head verification.

The reviewed generic editor/request ownership dependency `de9f98e9` is now
integrated locally at `f0803583`. Only the adjacent changelog entries conflicted;
both packs are retained. Its editor/private/public/review-page source is exact,
and the live opponent section order has no delta. Final combined verification
passes 230 web consumers, 105 affected API cases and one snapshot, both complete
typechecks, strict web/new-helper lint and configured API lint (zero errors;
existing large-service warnings remain). Help generation is unchanged.

The isolated Next-only production build reuses the verified 25b engine and
passes every unchanged budget: landing 190.1/215, Today 238.8/240,
game 312.3/440, opponent 448.2/500, Builds 197.5/270, Dock 215.7/225,
AIO 238.7/240 and widget 322.8/325 kB. The final actual-source browser run passes
197 checks/32 captures, including the absent-log read gate, with blocked external
traffic and zero writes. All eight representative images were inspected; three
are refreshed from this exact combined output. Root independently reviewed the
final timing and survival components plus phone timing/plan and desktop game
captures; final UI/visual signoff is complete.

The reviewed StrictMode follow-up `1b56cbf6` is integrated at `55c571b9`.
Capability retirement remains immediate; one microtask lets only the same scope
object retain a deduplicated read through root StrictMode setup replay. The exact
follow-up passes 136 focused ownership/review/Dossier/game tests, full web types
and strict helper lint. A fresh isolated production build, every unchanged budget
and the complete 197-check/32-capture browser matrix pass again. The actual
generic squash integration remains the prerequisite for the single coordinated
push and final expected-head checks.

No production or provider operations were performed. Never run an old f96
engine prebuild; shared engine writes must remain coordinated on 25b source.
