# Eager game-statistics maintenance: October 28 UTC

The program remains active and incomplete. This source candidate continues
`faster-dashboards` from writer PR 804/main
`7b9a30a288ca1adae7b90ac14ea360947cc26049` on
`codex/dashboard-game-stats-maintenance`. The original roadmap explicitly
requires `users.gameStats {total, latest}` maintained by ingest and wipe. This
stage implements eager maintenance in each selected games transaction; it is
not a replacement with lazy read repair.

**Locally verified writer candidate; release-wide delivery remains pending.**
The parent owns deployment, legacy-writer settlement and the ledger.
`/me`, Doctor and `GamesService.stats` retain their exact authoritative reads.
No retained-reader activation, flag, provider, infrastructure, native or agent
change is included. `USER_CACHE_ENABLED` stays off. This writer stage alone
does not complete `faster-dashboards` or the original 197-item program.

## Eager transaction contract

The first owner command is `findOneAndUpdate`, with `returnDocument: before`,
explicit session, no upsert and a narrow projection. The same command that
matches exact owner `_id`, captured epoch and fence/absence returns the prior
statistics while rotating protocol 2/revision and retiring old values. No
external pre-read supplies a delta base. Final statistics publication pins that
same authority plus the new revision and protocol, in the same transaction.

`gameStatsMaintenance` has version 1, ownerId, dedicated revision, epoch when
present and a status. Qualified prior totals require actual `gameStats`, exact
authority and version/revision agreement, safe nonnegative total and the shape
that the current writer can produce. Missing epoch is distinct from explicit
null. `dataRev` is never read. Old protocol 1 may leave new metadata behind but
it rotates revision/unsets stats, so the next current write bootstraps.

Each production games writer supplies one copied bounded selection: normal
upsert 1, current/alias quarantine at most 51, visibility/tombstone 1, restore at
most 100 game IDs and deletion at most 100 exact captured Mongo `_id`s. A missing,
ambiguous or oversized selector fails before transaction admission. Both subset
counts combine the original full stats predicate with that same selection.
The qualified total is prior total plus after-count minus before-count. No
JavaScript boolean mirror handles legacy array flags. An unqualified record
uses the original whole-owner count after mutation; unsafe/negative results or
an impossible zero-total/non-null-latest result recover the same way.

Latest always uses the original `find` predicate and `{date:1,_id:0}` projection,
descending date sort and limit 1, then `first.date || null`, under the session.
No `$max`, coercion, JS comparison or added tie breaker changes mixed BSON or
array-sort behavior. Empty 0/null and positive-total/null-latest remain valid.
Finite scalar Date/null is `ready`; a truthy unsupported raw latest remains raw
with `unsupported_latest`, which cannot qualify a future reader. A representation
over 16 KiB/unserializable or BSON round-trip-changing value is unretained rather
than normalized, including out-of-range BSON Date decoded as Invalid Date. Authoritative
reads still return their exact original answer.

Standalone development/test compatibility retires maintenance metadata as well
as stats/revision/protocol and never qualifies maintained state. Production
topology admission, eight-actual-promise bounds, 10-second transaction budget,
exact batch handle, GDPR epoch, owner/fence retirement and shutdown behavior from
writer PR 804 remain. Startup/drain diagnostics now report protocol 2 accurately.

## All selected groups and retry boundaries

Ingest, quarantine, hide/unhide, pending delete/tombstone, full/range wipe,
account erasure and in-app restore use the same helper. All maintenance
counts/finds, selected games commands and final stats publication carry the
session. Retry callbacks contain no provider/R2 work, cursor consumption,
notifications, fence renewal or recount side effects.

Zero-row full/range wipes run one bounded no-op transaction to initialize or
recover exact statistics. A zero-range match does not fabricate zero while
other games remain. Restore uses a maintenance transaction even if its initial
delete is empty, then immutable bounded insert batches. Each successful batch
eagerly persists its own count/latest/revision. A later ordered abort rolls back
that batch and metadata together, retaining earlier committed batches. New
maintenance metadata is excluded from exports and approved settings restore
continues to preserve live authority.

Every successful exclusive claim rotates epoch, including snapshot/preview, so
the next maintenance conservatively bootstraps. Ordinary same-epoch ingests
share a qualified delta base serialized by the first owner write. Routine
qualified ingest does two bounded count queries and the original indexed latest
query, with no full-owner recount; bootstrap does a full count instead. The
existing owner/date index is reused. A limit1 result is not proof of bounded
physical examination for all-hidden histories. No latency/cost saving is claimed.

Qualification trusts the writer protocol and schema, not the correctness of
arbitrarily forged plausible positive counts. Deployment overlap, unknown old
actors and raw Atlas/drop/`$out` restore can still invalidate that trust. Existing
old-writer settlement and post-restore retirement/rebuild gates remain mandatory
before a reader is introduced. External heavy/R2 side effects remain separate
from slim-games transaction guarantees.

## Regression and local evidence

All prior writer PR 804 fault cases remain. Their initial-owner command expectation
is adapted to atomic preimage capture, and their retired-state assertion now
also requires freshly maintained values equal to the unchanged authoritative
query. The restore replacement injection still occurs after the first actual
committed insert batch; the new empty-delete maintenance transaction is skipped
by that injection. Original owner/fence/batch/admission/retry assertions remain.

New prepared cases cover bounded copied selectors, metadata corruption, old
protocol fallback, empty/full/range wipe, no-data and positive-null semantics,
legacy array flags, strings/objects/array dates and oversize raw latest,
actual out-of-range BSON Dates that cannot round-trip through JS Date, including
the real server's `$toDate(Long.MAX_VALUE)` rather than only a driver fixture,
qualified command counts, original latest query shape, safe concurrent writes,
partial restore and final-publication rollback. Final focused verification
passes 93 cases in 3 suites; the remaining preserved writer PR 804 service/admission
set passes 129 cases in 15 suites: **222 cases across 18 suites**, with one Jest
worker, one cached Mongo 7.0.14 process at a time and downloads disabled.

Actual command monitoring records one whole-owner bootstrap count, then exactly
two bounded subset counts, zero whole-owner counts and one original sorted
latest query for qualified ingest. Counts and latest share the owner's
transaction session. Real server `$toDate` of signed 64-bit max
`9223372036854775807` produces an Invalid Date at the JS driver boundary;
maintenance omits its retained stats and the unchanged authoritative read still
returns Invalid Date. This is local synthetic data, not production-account or
physical failover acceptance.

Whole API types pass. The initial type run exposed a typed Uint8Array/Buffer
API assumption; exact serialized-byte equality now uses `isDeepStrictEqual`,
and the final focused run retests the corrected source. Strict lint on the new
module, helper and three owned tests passes with zero warnings. Existing edited
files lint exits zero with the same 14 warning sites and method sizes as the
baseline. `git diff --check` passes. Initial type evidence is preserved; no
assertions, failures or skips were removed. MongoMemoryServer's intermittent
ECONNRESET warning during intentional stop remains in the logs; every owned
replica-set process is awaited, final Jest asserts ESRCH, and all three recorded
owned PIDs/loopback ports are closed. No unrelated process was killed.

Evidence packet:
`C:\SC2TOOLS\.cache\game-stats-maintenance-verification-20261028`.
`api-source-freeze.json` pins the 11 final API paths; the full implementation
manifest adds the four documentation/changelog paths. Source and test
qualification does not imply exact-head CI, full API/web build, all 83 route
budget/asset gates, deployed protocol 2 or old-writer cutover acceptance. The
existing Help copy remains accurate because this stage changes no user flow or
reader response; engineering and handoff documentation describe the new
maintenance contract without adding implementation details to product flows.

Design packet:
`C:\SC2TOOLS\.cache\game-stats-eager-maintenance-design-20261028.json`.
Independent source review is separate from these local executions and the
remaining release-wide checks and production proof. No commit, push, PR,
provider mutation or production behavior is claimed by this child checkpoint.
