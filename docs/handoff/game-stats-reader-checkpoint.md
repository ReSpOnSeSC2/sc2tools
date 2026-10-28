# Maintained statistics reader: October 28 UTC

This slice is in preparation on `codex/dashboard-maintained-read-prep`, based on
main `2242d112d9124bca8cfae92d00bc852ccab2f85b`. Nothing in this checkout is
released. `/me` and Doctor now have candidate wiring after the floor gate;
`GamesService.stats` is unchanged. `USER_CACHE_ENABLED` remains off. This work does not close
the wider `faster-dashboards` item.

## Fresh authority and bounded bootstrap

Maintenance version 2 is a new source-version boundary; the transaction protocol
stays version 2. Version 1 cannot supply a new writer's delta base. Its first
mutation recounts using the original Mongo eligibility and sorted-date query
inside the existing transaction. Later qualified writes retain bounded subset
deltas. An old maintenance-1 writer will publish version 1, which the strict new
reader rejects. No bulk metadata write, environment flag or read repair is added.

Before a process can mint version 2, one client-scoped readiness promise obtains
the current primary's `operationTime`, advances an explicit causal session, and
acknowledges a real `users` collection read with majority concern. It verifies
primary continuity. It does not infer a barrier from `$clusterTime`, a ping or a
wall-clock delay. Each new transaction uses an explicit causal session advanced
to the acknowledged floor before its first owner write. MongoDB's driver sends
this as first-statement `afterClusterTime`, including when that statement writes.

The floor is copied per caller, held only for its connected client and coalesced
under existing eight-task writer admission. Failed setup publishes no readiness,
starts no games transaction and returns a 503; later demand may retry after a
one-second cooldown. There is no background retry. Existing authoritative reads
remain available. Shutdown owns actual setup/work/session promises and checks
`stopped` again after setup so a held barrier cannot start late writes.

This runtime floor is paired with the parent's actual qualified approved-writer
cutover receipt in
`C:/SC2TOOLS/.cache/game-stats-cutover-qualified-receipt-20261028.json`.
That receipt uses an attributed old-instance SIGTERM and Render's conservative
published 300-second bound, plus an actual later own-operation/causal-majority
observation. It does not invent `shutdown_complete` or assume the default
30 seconds. Only inventoried approved writers are covered. Raw restore and
manual collection replacement still require the existing authority-retirement
and rebuild procedure; arbitrary out-of-band writes are outside the contract.

## Request-local reads

The strict proof accepts only a fresh primary owner row, maintenance 2 in
`ready` status, transactional protocol 2, exact BSON owner identity, matching
dedicated UUID revision and exact epoch presence/value. Any GDPR-field presence
rejects reuse, including expired or falsy residue. A safe nonnegative total and
finite scalar Date or null are required. Positive total with null latest is
valid. Unsupported raw BSON, malformed or oversized projected candidates miss;
the unchanged authoritative query must supply their exact answer. The bound
applies to projected candidate data, not the entire stored user document.

`getMeSnapshot` and `getDoctorSnapshot` are internal envelopes used by `/me`
and Doctor, including the existing authorized support caller. They combine the existing summary/profile read with only onboarding/archive
preferences and proof fields. Public summary/profile DTOs and their queries
remain unchanged. Doctor's original busy/session-policy errors precede proof
validation. Missing owners never fabricate zero. No proof is exposed publicly
or reused across requests. A valid tuple skips both original game queries;
a miss calls the original service once, performing its unchanged count and
sorted-latest queries. Narrow older injected services retain their original
summary/profile, preferences and stats path. No speculative game query or
additional owner read is added.

## Verification status

The initial proof/envelope preparation passed 94 tests in two files and API
types. Strict new-file size/complexity checks pass with existing Users warning
counts unchanged. Its first complexity failure is retained and was corrected
without weakening the rule. Those runs predate the causal-floor/version change
and are historical.

The current floor gate passed 208 tests in six files with one Jest worker and
one cached MongoDB 7.0.14 member, downloads disabled. Whole API types and strict
new-file/owned-file lint passed with no added baseline warnings. Its cache
receipt is `maintained-read-preparation-verification-20261028/floor-gate-02.json`.
Actual owned child, listener and descendant inventories are clear. The first
denied CIM cleanup query and original Mongo shutdown warning are preserved;
the successful scoped second inventory supersedes the unqualified first one.

Floor tests cover actual promise ownership, cooldown, primary changes,
unknown outcomes, client isolation, shutdown and per-transaction causal
advancement. A real replica-set command-monitor case passed, asserting the
majority read and first owner command carry the acknowledged causal floor and
that a plausible maintenance-1 count is fully recounted. Existing writer fault
assertions remain; their unit harness explicitly isolates the separately tested
floor and their maintenance-version expectations follow the current version.

The new real-handler/service route suite passed all 26 cases with a single cached
replica-set member. It checks zero stats queries for ready proof, one original
stats call/two Mongo queries on misses, one owner/preferences read, literal
DTOs, original archive warnings, BSON array eligibility, account/owner/fence
transitions, profile error precedence and failure propagation. The same
serialized run passed 70 existing Foundation/profile/replay-archive/support
cases: 96 tests in five files, zero failures or skips. Whole API types and
strict new-file/owned-file lint passed after wiring, with no added warnings.
Thirty owned/protected pre/post pins matched during those runs. Exact recorded
test/type/lint/native member PIDs, listeners and scoped Jest-child inventories
are clear; no processes were killed.

Three original route attempts are retained. The new fixture initially omitted
unique Clerk IDs, used Jest row arrays without the argument wrapper, expected
a plain sort object where command monitoring reports a Map, and incorrectly
expected a cache header that the unchanged Doctor router does not set. These
were corrected at the fixture/driver/HTTP boundary. All original assertions
remain, and no product change was needed to make those attempts pass. The
final run is `route-tests-04` in the same verification packet; the original
Mongo library shutdown warning is also retained.

Root owns final source review, fresh-main integration, full build/budget and
asset checks, exact-head CI and deployment. No production activation, measured
savings, provider, engine or native change is claimed here. ADR 0070 and the raw
restore runbook state the external cutover and authority-retirement boundaries.
