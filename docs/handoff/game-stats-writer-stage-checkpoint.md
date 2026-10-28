# Game-statistics writer prerequisite: October 28 UTC

The program is active and incomplete. This is the writer-first prerequisite
for `faster-dashboards`, based on main
`9d6525e54a81dc23768232881f063d7864d24055`. It invalidates any old
`users.gameStats` and rotates a dedicated revision in the same Mongo transaction
as each selected games membership/date write. It does **not** maintain eager
counts, retain a new lazy snapshot, change `/me`, or introduce a statistics
reader. `USER_CACHE_ENABLED` remains off. No agent release, provider change,
new flag, infrastructure, migration execution or production savings is claimed.

Root additionally verified the changed Help article with93 cases in13 suites,
strict article lint and fresh whole-web types. The independently reviewed
18-path candidate and13 frozen API source pins remain unchanged. Evidence is
copied to `validation/game-stats-writers/`. Exact-head API/web CI, actual
production startup capability, relevant signed-in acceptance and legacy-writer
settlement are still pending; no retained-reader eligibility is asserted.

## Authority and admission

Normal admission captures the current owner `_id`, mutation epoch and absence
of `_gdprMutation` in one bounded users read, before external payload work.
Missing epoch matches only `$exists: false`; explicit null, malformed values,
arrays and objects fail closed. A normal operation cannot inherit an active
exclusive operation's epoch and wait until its fence disappears.

`POST /games` captures one server-owned handle for the whole admitted batch,
before quota/pool awaits, and passes it through normal upsert, its forwarding
method and resumed quarantine. An authority mismatch aborts the remaining batch.
The client cannot supply this handle. A different userId cannot use it. Direct
single-operation callers capture once at their start. Admission is the first
server capture; HTTP arrival before capture does not grant an older epoch.

Every successful exclusive GDPR fence claim atomically rotates
`gameStatsMutationEpoch` in that same guarded users update and returns its exact
owner with the new epoch. Renew/release preserve it. This conservatively includes
snapshot/preview claims, so an already-expired upload may need a safe retry even
for those operations. A held request whose outer data lease expires cannot
commit after a same-owner wipe/restore releases its fence. A fresh admitted
retry can. Ordinary concurrent ingests share an epoch and do not retire each
other. Destructive batches require exact owner, epoch and fence ID; final
account deletion pins the original owner and fence rather than a replacement.

The owner revision write precedes games commands in each transaction, with
snapshot read concern and majority+journaled writes. Installed Mongo driver
6.13.0 supports the 10-second `withTransaction` `timeoutMS`; commit and write
concern waits are bounded at five seconds. Eight actual transaction promises
are admitted per process, with no queue. Shutdown stops future dispatch before
draining those promises. Promise settlement does not prove that an ambiguous
server commit rolled back, and is not a legacy-writer cutover receipt.

## Integrated membership/date groups

| Group | Source and bound |
| --- | --- |
| Ingest insert/date replacement | `services/games.js`: conditional update, fresh deleted/pending check and insert fallback use the session. Heavy upload precedes the transaction; lease waits remain outside retries. |
| Resumed quarantine | `services/games.js`: current marker plus at most 51 current/alias IDs share one owner/session. |
| Hide/unhide | `services/gameControls.js`: owner exclusion transition under exact admitted fence. |
| Permanent deletion | `services/gameControls.js`: pending membership and final tombstone each transact; payload cleanup is between/outside retries. |
| Full/range history wipe | `services/gdpr.js`: transactions delete at most 100 captured `_id`s while retaining the original range/ID filter. |
| Account erasure | `services/gdpr.js`: bounded existing-owner deletes, then exact-owner/fence user deletion. |
| In-app restore | `services/userBackups.js`: authority captured before staging; bounded deletion and immutable insert batches of at most 100/about 4 MiB. |

Every games command inside these transaction callbacks receives the session.
R2/provider work, cursors, settings reads, staging, fence renewal, notifications,
recounts and guide cleanup remain outside retry callbacks. The existing
opponent build-order lease policy is preserved. Mongo callback retries do not
repeat external uploads; commit retries do not repeat the callback.

Restore remains a multi-batch operation: a later failed ordered batch aborts
that batch and its revision, while earlier committed batches remain. Replacement
of owner or fence blocks later batches. Approved settings restore pins the same
authority and cannot restore protocol/revision/epoch metadata. Exports omit that
live authority. The Help recovery paragraph preserves this partial-operation
boundary rather than claiming whole-history atomicity.

Already-missing-owner erasure retains the existing destructive orphan cleanup:
absence checks, no owner upsert, no qualifying stats and no resurrection. It
does not assert atomic absence across hypothetical reuse of an internal userId.
Standalone development/test compatibility retires retained stats but strips
revision/protocol and marks the writer unsupported. It never qualifies a future
snapshot and does not carry transaction guarantees. Production composition
rejects unsupported or omitted topology capability before service work. Startup
probes the actual connected Mongo topology; no Atlas setting is changed.

## Enumeration and external boundaries

Independent source inventory covers direct/dynamic/aliased games commands,
scripts, migrations and jobs. Reclassification, build-intent provenance,
opponent/MMR repairs, archive/playback markers, macro/leaks, moments and lease
metadata do not alter this exact stats predicate. Existing migrations only alter
those non-membership fields; the duplicate-games audit is read-only. The
load-test script calls the integrated HTTP ingest route. Authoritative
`GamesService.stats` predicate, raw Mongo latest-date sorting and return value
are unchanged, including unsupported legacy BSON values.

Raw Atlas/Mongo restore and the documented drop/`$out` timebase rollback remain
external boundaries. They can rewind both games and users authority. Before any
future retained reader, stop and settle all old actors, retire/rebuild derived
authority and verify a new cutover receipt. The database restore runbook records
this requirement. No production topology/cutover proof has been performed here.

The guarantee here concerns slim games membership. A held external heavy/R2
side effect is not made atomic with erasure; existing store cleanup and retry
contracts remain separate. No broader GDPR side-effect atomicity is claimed.

## Verification and delivery status

Final local API verification passes **168 cases across 17 suites**, including a
real single-member Mongo7.0.14 replica set and real HTTP batch admission. It
covers partial ordered rollback, transient callback retry without external
repeat, lost commit acknowledgement, an ambiguous error after an actual commit,
owner/fence replacement, full erasure, held ingest after full/range wipe/restore,
expired HTTP batch retirement, active-fence admission, fresh concurrent ingests,
all selected service groups, range scope, bounded restore and unchanged leases.
Original GDPR race names/assertions are preserved; its injection targets the
failed-claim reread after the new identity pre-read. No failing assertions or
skips were removed. Cached binary only, `MONGOMS_RUNTIME_DOWNLOAD=false`, one
worker; no downloads. Final owned Mongo PID exits and loopback ports were checked.

Whole API types pass. Strict lint on the helper/new tests/admission regression
passes with zero warnings. Existing edited files lint exits zero with the same
21 warning sites as main: 17 in the earlier seven files plus four existing route
size warnings. `git diff --check` passes. Help is a copy-only data edit; web Help
regression and release-wide CI/build/deployment acceptance remain parent-owned.

Evidence: `C:\SC2TOOLS\.cache\game-stats-writer-verification-20261028`, including
`writer-batch-services-09.log`, `api-types-final-03.log`, strict/owned/baseline
lint logs, `api-source-freeze.json`, `owned-cleanup-final.json` and independent
enumeration. Original failed attempts remain: sandbox Jest cache EPERM, incorrect
synthetic Mongo error/unique-key fixture assumptions, initial overbroad metadata
command matching, initial narrow JSDoc types and console lint warnings. A denied
CIM observation and a metadata scan of empty success logs are not process proof;
the successful PID/port checks and Jest ESRCH assertions are separate evidence.
MongoMemoryServer occasionally logs ECONNRESET during its intentional stop; the
tests still await stop and verify process exit, and that warning is retained.

Source review identified the earlier owner-only candidate's retained-owner
wipe gap, then the outer-batch recapture and active-fence capture gaps. The epoch,
batch handle and unfenced capture above close those distinct cases. Pre-epoch
helper/GDPR copies are retained and match their independently recorded hashes;
the reconstruction method is explicitly qualified in
`pre-epoch-source-retention.json`. No unexecuted red baseline is claimed.

No commit, push, CI, deployment or production acceptance is claimed in this
checkpoint. The parent still needs maintained/lazy `users.gameStats` semantics,
lighter `/me`, writer cutover proof, additional dependency-safe cache coverage
and revocation-coherent device auth. `faster-dashboards` stays partial;
`analysis-corpus-local-cache` and the complete original program remain unfinished.
