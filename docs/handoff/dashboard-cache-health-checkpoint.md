# Personal chart cache monitoring — adoption checkpoint

Adopted 2026-10-27 as the next bounded `faster-dashboards` presentation slice on
`codex/dashboard-cache-health`, based on verified main
`900ac8dc55954cd07d0b1162bac3f0d18207106d`. PR796 is merged and remains a separate
release. This source has not yet been compiled, tested, committed, deployed or
accepted live. Root owns serialized verification and delivery.

The candidate manifest and prior independent review match their pinned SHA256
values. All thirteen packet members, eleven replacement/add targets and five
source dependencies were rechecked. Existing replacements matched raw hashes and
new targets were absent. The two exact-hunk targets (`app.js` and `CHANGELOG.md`)
have CRLF in the fresh checkout and LF in the packet source: LF-normalized hashes
match both pinned preimages, and the source revisions have no content diff for
these paths. Their original line endings and all other content were preserved.
The preimage and EOL receipts are retained under
`C:/SC2TOOLS/.cache/dashboard-cache-health-adoption-*-20261027.json`.

## Adopted behavior

The existing authenticated admin health response gains an optional
`personalChartCache` snapshot. It uses only the current UserCache instance's
enabled property and selected scalar counters, sampled after the original health
work. OFF returns before reading counters. Missing, throwing or malformed
reporting becomes null without failing the original health check.

The current production construction uses default LIMITS:512 entries and64MiB
of combined accounted/reserved bytes. This snapshot validates that contract,
not arbitrary future/test constructors with larger overrides. Allowed counters
are hit, miss, entries, bytes and reserved_bytes; no owner, key, query, token,
response body, map, salt or revision object is serialized.

The new independent card appears under Operational health using its existing
30-second request. Off hides figures. Enabled shows actual process-lifetime
observations and cache-accounting bytes. Missing or malformed data says Not
reported, never Disabled. Existing failed/forbidden health branches withhold
cached status claims. No new request, timer, polling interval or activation
control is added. Existing provider/infrastructure refreshes remain unchanged.

## Verification still required

Candidate tests cover real admin-route authorization and no-store/error behavior,
one original health invocation, off-without-counter-read, one enabled getter
snapshot, allowlisting, malformed/default-bound handling and unchanged service
data. The existing actual-app admin health case checks wiring with the default
OFF setting. Real UI tests retain the prior error/retry/status assertions and
add optional-data, current error/403, process-counter and existing-polling cases.

The initial adoption had no runtime proof. Independent source review found no concrete
functional blocker. Root must run meaningful API/UI tests, whole types,
changed-source lint and the actual build/all original route budgets.
Visual/AA proof and exact-head CI remain separate gates; no synthetic or live
acceptance is inferred. The original failed/private-search receipts remain intact.

No flag, environment, provider, cache/revision algorithm, public-health endpoint,
database query/index/migration, infrastructure, budget, installer or release
change is included. `USER_CACHE_ENABLED` remains off. Whole `faster-dashboards`
stays partial: maintained `users.gameStats`/lighter `/me`, dependency-safe cache
coverage and revocation-coherent device-auth reuse remain unfinished. Local
corpus delta/removal/version contracts, IndexedDB, account clearing and history
controls remain separate open work.

Final local verification:107 API tests and28 UI tests pass. Whole API types and production web build/types pass. All83 original route caps, retained40source/sevenasset/fourgame admission, deterministic Help97 and UI baseline1764files/639inherited occurrences pass. New API files and all changed UI files pass strict lint; the six existing API warnings match fresh main by rule and count. Browser proof passes6cases/48specimens/48AA scans, all four widths and both themes, with zero page errors/nonfixture requests. Root reviewed phone Enabled and desktop maximum counters; padding is applied directly to the Card to retain intended spacing. Captures are synthetic API snapshots, not live acceptance. Exact-head CI, merge and production verification remain required. The roadmap ledger retains all197items and marks unreconciled augments unknown.
