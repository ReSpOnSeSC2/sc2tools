# Build dossier insights checkpoint

Branch: `codex/wave4-build-dossier-insights`. ADR0057 owns the bounded design.

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
dossier integration/nav tests pass. The current focused web set is 43 tests,
with 30 game-page and four recovery consumers previously green. Full types/scoped
lint pass. Combined API 151 tests/ten suites + one snapshot and all 145 custom-build
service regressions pass. Independent review cleared the final API additions.

The approved seven-minute cutoff dependency `3dceab1c` was integrated at `2a4c5689`.
Actual main `e2fa5d08` has a clean merge tree identical to that HEAD tree; no extra
bookkeeping merge is needed. Required engine `25b300818c31d41b` builds/smokes
successfully. The production Next baseline passes every unchanged budget:
landing 214.9/215, Today 239/240, game 312.7/440, Builds 196.7/270,
opponent 471.6/500, Dock 215.2/225, AIO 238.3/240, widget 322.4/325,
guide 168.7/175 kB. It uses the public nonfunctional example Clerk key from CI.

The actual-source loopback browser matrix passes 149 checks with 24 captures at
320/390/768/1440 in both themes using production CSS/fonts. It covers keyboard
selection/focus, exact example links, matchup/source changes, small samples,
owner loading/B/A, clock seeking, overflow/targets and axe. No external traffic
or writes are allowed. Captures live under `.cache/build-dossier-insights-evidence`;
fixed mobile navigation is hidden only for element screenshots so it does not
obscure a stitched card. Heading order and fully visible mobile delta text were
corrected from the browser evidence; both timeline columns retain equal slots.

Selected examples now carry sampled navigation, requiring the existing explicit
broader-scope opt-in before Older/Newer. Optional nav removal resets its active
anchor. These final small deltas and library/card Held wiring still need the
final combined production/browser pass. The Held badge is tested in isolation;
Build-card/Builds-tab integration awaits actual Unified editor #738 merge. Help,
ADR, changelog and owner notes are written. No Dossier PR has been created yet.
No production or provider operations were performed. Never run an old f96
engine prebuild; shared engine writes must remain coordinated on 25b source.
