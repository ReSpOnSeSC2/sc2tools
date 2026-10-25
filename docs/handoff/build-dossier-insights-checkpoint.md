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

API verification: 149 tests across ten suites and one snapshot, full API type
checking and strict lint for the new helpers/tests pass. Web cards, consumer
tests, Help, browser evidence and final integration/build remain in progress.
No production or provider operations were performed. Do not run an old f96
engine prebuild; integrate the owner's seven-minute cutoff source and coordinate
the new engine hash before any required production build.
