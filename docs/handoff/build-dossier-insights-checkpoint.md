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

New card/helper/wrapper consumers, the existing 39 game consumers and 23 dossier
integration/nav tests pass, along with web types/scoped lint. Help sections are
written. Build-card/Builds-tab summaries await actual Unified editor integration;
browser evidence and final integration/build remain in progress.
No production or provider operations were performed. Do not run an old f96
engine prebuild; integrate the owner's seven-minute cutoff source and coordinate
the new engine hash before any required production build.
