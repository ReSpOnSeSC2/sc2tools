# Opt-in personal chart cache: source checkpoint

2026-10-26. Base provided by the parent: `9a68c480c9d19278642b5c546fe4b3ab081fa6b1`,
worktree `wave3-guides-expansion`, branch `codex/wave5-revision-chart-cache`.
Initial preparation was source only. Authorized local type, lint and Jest runs
are recorded below; database execution used local MongoMemoryServer fixtures.
No build, generator, Git mutation, browser, provider or production database
operation or activation was performed by this author.

## Current validation status

Validated code/test revision: `c207530501f954f78f7871552bd8bf1999311622`, tree
`d9a4d6f2f1bc0f7c2abea0d4528831f51d7ae505`. Only this checkpoint and the existing
changelog entry are finalized afterward; product and test bytes are unchanged.

- Evidence covers **475 distinct selected cases across 28 files**: 467 prior
  passing cases from 27 unchanged files plus eight actual fresh passing cases
  in the repaired attribution-writer file. The entire old failed file, including
  its six old passes, is excluded from retention. This is not a fresh 28-file
  rerun or a 473-plus-eight count.
- Whole API types passed. Raw strict lint exited 1 with exactly 56 accepted
  inherited warnings; the separate full-tuple audit exited 0. The 12 warned
  files retain their raw-byte pins; the other 16 files have zero warnings.
  There are zero lint errors, suppressed messages or new warnings. Raw lint
  remains recorded as failed; no rule, threshold or configuration was changed.
- Full API tests and CI remain unrun. `USER_CACHE_ENABLED` stays default-off;
  no production activation, deployment validation or measured savings is claimed.
  Before enabling, verify one instance and a fully settled deployment with every
  writer upgraded. Broader dashboard, ETag and corpus work remains separate.

The focused result, retention arithmetic, immutable receipts and process closure
are recorded under Final focused validation below. Historical sections preserve
the earlier failures and source-only freezes rather than replacing their evidence.

## Prepared behavior and boundaries

The default-off flag is `USER_CACHE_ENABLED`; only literal `true` opts in. Off
uses original route responses and service work with zero additional revision DB
commands, owner lookups, retention, queue limits or cache busy responses. Before
enabling, verify a single instance, fully settled deployment and all upgraded
writers; the author has not verified or changed any deployment setting.

Exactly six private personal chart GETs participate: timeseries, day/hour,
length buckets, activity calendar, momentum and map trend. Existing aggregation
methods, all global filter semantics, owner scope and history bounds are retained.
No web, clientApi, Settings, UsersService, /me, aggregation-math or index source
is changed. Responses remain ordinary 200 JSON; conditional/ETag behavior is
explicitly pending. See engineeringexplanation.md for bounds and failure rules.

Retirement covers GamesService upsert/quarantine; custom-build transaction rename,
single/all promotion and quick tag; check-in/notes/pending/bind/dismiss;
macro scalar/leak write; swallowed region/identity stamping; existing bounded MMR
enrichment with owner projection; hide/unhide/pending deletion/tombstone; GDPR
known/unknown deletion; and partial restore. No socket is required. Promotion
staging, storage/lease markers, opponent-note collection writes and identity-graph
changes are not selected response inputs. Broader caches must model them before
being added. isLadderMap is not the authoritative isLadderGame filter.

The cache charges UTF-8 body/key bytes including retired response pins, reserves
before computation and bounds computations, per-owner work, waiters, joins,
response leases and deadlines separately. Owner existence/deletion is checked
before hits and delayed responses. Unknown writes synchronously retire local
generations even when durable increment fails; no upsert recreates an erased user.
Revision persistence itself has four permits and no fallback waiter queue;
capacity failure preserves the write outcome and makes reuse unavailable.
dataRev is not a corpus watermark or distributed transaction guarantee.

## Exact approved source manifest

The initial 31 paths comprised:

- 17 product: util/userRevision; middleware/userCache; app/server; aggregation and
  metrics routers; games, customBuilds, buildIntents, buildIntentGameState,
  buildIntentBind, perGameCompute, opponents, gdpr, gameControls, userBackups;
  existing opponentMmrEnrichmentJob. All are under `apps/api/src/`.
- Eight tests under `apps/api/__tests__/`: new userRevision, userCache,
  userCacheRoutes, userRevisionGameWriters, userRevisionAttributionWriters,
  userRevisionDestructiveWriters; existing opponentMmrEnrichmentJob and metrics.
- Three docs: engineeringexplanation.md, this checkpoint, root-coalesced CHANGELOG.
- Three flag paths: `apps/api/src/config/loader.js`,
  `apps/api/__tests__/configLoader.test.js`, `apps/api/.env.example`.

Before bytes/absence were copied before edits to
`.cache/revision-cache-prep-9a68c480/before/`; its 31-path receipt SHA256 is
`0b34571b5041a582e8432a3c2f5d9e7fae386881db748b10418b0d4286e29e18`
(22 existed, nine absent). The source freeze is copied separately under
`.cache/revision-cache-source-9a68c480/source/` with a new receipt. Neither local
receipt nor raw cache copies are test/CI dependencies.

The original 31-path source receipt
`17a74f0e58c1257666b9e01a0a45b224cfdd81c47f3f0e2f3e2d860745881887`
and all original raw source copies remain preserved. Independent source review
requested three repairs, authored only within the same manifest:

- Reject a generation retired during guard, work or subscriber delivery with
  503/Retry-After: 1, no old DTO and no automatic retry. Identity validity is
  separate from cache eligibility, so stable-generation bounded fresh reads can
  still bypass retention. Held real API DTO tests cover completed ingest, hide
  and wipe before publication, followed by a separate fresh request.
- Bound owner/identity guard IO independently at 16 active with no queue,
  retaining permits until actual settle despite HTTP abort/close. Tests hold
  findOne, identity and post-compute guards through repeated abort/replacement
  attempts and assert issued-operation limits and counter cleanup. Metrics use
  fixed guard_active/guard_rejected names.
- Narrow the durable increment predicate to supported BSON int/long/double safe
  integers or missing. Real-Mongo tests compare actual serialized unchanged BSON
  for Decimal128, unsafe Long/Double and nonfinite fields, with valid Long/Double
  controls. No legacy value is automatically repaired.

The repair freeze is separate under
`.cache/revision-cache-source-9a68c480-repair1/`, with all 31 source copies and an
exact delta against the original source receipt. Repair tests were unrun at
that source freeze; later results are recorded below.

## Validation boundary amendment: 32-path scope

The parent subsequently added exactly one feature path:
`apps/api/__tests__/routes.integration.test.js`, plus this existing checkpoint.
The other 30 feature files remain byte-identical to repair1 f75cdd0a. Before
amending either file, raw bytes and hashes were preserved under
`.cache/pulse-fixture-repair-6bd36a9c/before/`; receipt SHA256 is
`45fe39fc9c286429ba72ce612a42b1258b9cc14b1ddbeb5a4474a412995bcf9d`.

The selected router suite's numeric-Pulse-ID/undefined-marker ingest follows
the real opponent enrichment path. Its default Pulse service delegated to
global fetch, while the existing Jest setup blocks only Liquipedia. The fixture
now injects the same real PulseMmrService with a rejecting fetchImpl already
used by the shared build-intent harness. Numeric IDs, undefined markers, HTTP
requests and every assertion are retained. No payload skip, global fetch patch,
product route, writer or production flag is changed.

For the selected 28-suite packet, 16 suites construct local MongoMemoryServer
URIs directly, three use shared harnesses that do so, and nine are config/pure/
fake-DB tests. None imports server/bootstrap/dotenv; config parsing uses explicit
fixtures. Mongo/R2 environment inspection recorded presence booleans only, all
false. This is database/config isolation evidence, not a claim that a
Liquipedia-only setup is a global provider deny rule. The remaining actual
selected provider paths were traced before later validation; this remains a
bounded selected-path source audit.

The original validation packet 83b7fafd remains immutable and was not executed.
New validation metadata must add strict JS path 28 and original same-filename
baseline 20, preserve the same 28 suites and existing dependency dictionary,
and pin the parent's next source commit/tree. At this amendment's source freeze,
all API checks were unrun; the first type result is recorded below.

## First API validation and annotation repair

The parent granted one exact dfffff51 runner invocation at source4ed16b50/treeee9.
Full preflight passed, then whole API types ran once and exited2 with exactly
two inference errors in middleware/userCache.js: TS7023 on retiredPinnedBytes
and TS7022 on _retiredBytes. The getter/property inferred each other through
numeric byte accounting. Strict lint, its baseline diagnostic audit and Jest
were not started; no Mongo or provider stage ran. No retry or source repair was
performed during validation.

The full postflight again passed all941 inputs,32 owned source paths,26,114
dependency pins, tools, tracked-clean4ed/treeee9 and map seed4d525b8e. TSC PID29432
closed normally; session24732 ended RED/exit1. Closure observation found no TSC
process, no Node process remaining in the exclusive run start window and no
known-owned listener. CIM command-line lookup was unavailable in the sandbox;
the recorded fallback used Get-Process and numeric netstat, without escalation,
ACL workaround or unrelated process cleanup. The runtime slot was released.

Raw logs/commands/guards/result/closure and both source-before files are
preserved under `.cache/type-annotation-repair-4ed16b50/`, with a receipt.
The parent authorized exactly this getter's numeric return annotation and this
checkpoint. The annotation breaks the inference cycle without changing an
initializer, runtime behavior, any cast, tsnocheck or lint rule. Other30 source
paths stayed unchanged. At that annotation freeze, validation was pending
independent review, parent preservation and a new exact runtime grant; the next
run resolved both type errors.

## Second API validation and response-lease extraction

The parent granted one mechanical, unchanged d21f592a runner invocation at
sourcebbbbca07/treeada848be using receipt400ac58d. Whole API types passed with
exit0 and no diagnostics, resolving both earlier inference errors. Strict lint
then exited1: zero errors and58 warnings across28 files. Its20 original
same-filename comparisons reported zero errors and56 warnings. Each existing
file retains its original warning count, but six message strings differ because
the reported function lengths changed; this is diagnostic evidence, not a
strict-lint waiver. Jest and Mongo were not started. No retry occurred.

The two warnings in new files were an unused entry binding in userCache.test.js
and the69-line send method exceeding the60-line rule. After all22 child commands
closed, the full postflight passed941 inputs,32 owned source paths,26,114
dependency pins, tools, tracked-cleanbbbb/treeada and map seed4d525b8e. Closure
observation found all22 recorded child PIDs absent, no Node process remaining
from the exclusive run window and no known-owned listener; the runtime slot was
released. Raw result SHA256 is
`3bff86b3f9a796858613604a88d6fc82e822b96a78610bc24fec8f4a61b01e1a`.

Before the next repair, three raw source files and all97 closed-run evidence
files were copied under `.cache/response-lease-repair-bbbbca07/`; before receipt
SHA256 is `ff826fcd92f7a2194f7b6a5a029085715bb7bddb0251de68d5dd00dc3998dae6`.
The parent authorized only middleware/userCache.js, userCache.test.js and this
checkpoint. The existing contiguous response-cap, subscriber, close closure and
listener-registration block is moved verbatim into beginResponse, which returns
the same sub and close objects. send retains its opt-in/method/route bypass first,
then obtains those objects and enters its unchanged try/catch. Counter, timer,
listener, abort, queue, pin, releaseResponse and drain ordering is retained.
The test removes only the unused entry binding; every assertion is unchanged.
Other29 source paths remain byte-identical. No lint configuration, suppression,
new any type or cache behavior was added. The extraction was source-only at
that freeze; its later validation is recorded below.

## First selected Jest run and promotion-fixture repair

The parent reviewed the new exact inherited-warning auditor and granted one
e804abcda/4070fd08 invocation, receiptf705ee45. Whole API types passed. Raw strict
lint remained exit1 with exactly56 accepted inherited warnings, zero errors and
zero suppressed messages; the separate exact-tuple audit passed with exit0.
All12 warned source files matched their raw-byte pins and the other16 files
were clean. This is accepted prior debt, not a strict-clean or all-zero result.

The one in-band local-Mongo Jest invocation ran all28 selected suites:27 passed
and1 failed, with473 tests passing and2 failing out of475, no pending tests and
no retry. Both failures were the reclassify/reclassifyAll unknown-promotion cases
in userRevisionAttributionWriters.test.js. Source tracing established that the
unqualified first-updateMany spy intercepted expired opponent-write lease
maintenance before either semantic promotion fence. The fresh row has no lease,
so that maintenance matches zero rows. Its rejection leaves the earlier snapshot
current, as expected for that operation. Actual single/all promotions already
call gameWrite around their runId-filtered commit pipeline; no product fence gap
was found in these two paths.

Full final guards passed941 inputs,32 feature paths,26,114 dependency pins,
217 retained proof pins, the12 warned source pins, tools, tracked-clean
e804/tree4070 and map seed4d525b8e. All three recorded children closed. The host
closure observation with explicit UTC bounds found no Node/mongod process from
the exclusive run window and no known-owned listener. An earlier mixed-DateTime
observation was retained but superseded by the corrected UTC record; unrelated
processes were never touched. The runtime slot was released. Raw result SHA256
is `8ceb68b20967c72e72986dd6d77a332b02687115e26b34471c5f7977a16903e1`;
Jest JSON SHA256 is
`ec4490e6fdacd24457b6d31e998b958066dd6cfc43fefc583cb31542877c0455`.

Before the next repair, this test and checkpoint plus all22 closed-run raw
records were preserved under `.cache/promotion-fixture-repair-e804abcd/`;
before receipt SHA256 is
`8a510b013ebf3f280c856baabd1ae3dd986901c6e9f4ad51bca1021196096482`.
The parent authorized exactly those two existing paths. The spy now delegates
all non-target writes to real Mongo and injects once only at the actual
promotion: a nonempty runId filter and an array commit whose first $set owns
myBuild, or the actual quick-tag findOneAndUpdate. It excludes lease maintenance
and marker-only cleanup. During the selected attempt it asserts retirement,
calls the bound original Mongo write, checks matched/modified1 for updateMany,
and verifies the persisted label changes from Unclassified to Gateway opener
with slugopener before throwing the same error. The original rejection-identity
and final-retirement assertions remain, with an exact single-injection check.
The Gateway log/rule and all other fixtures, positive tests and real services
remain unchanged. Other30 source paths and all12 inherited-warning source-file
pins remained byte-identical. The fixture repair was unrun at that freeze;
independent review, parent preservation and focused validation followed.

## Final focused validation

The parent preserved the two-path fixture repair as c2075305/tree d9a4d6f2,
source32 receipt
`8be6f957074c74217159b14b4f8babee4f90951c22846358151107dac8a58450`.
The focused packet reused byte-identical reviewed runner e5ab59d2, auditor
99721145 and dictionary d367de86. Its only execution-list change selected the
one actual attribution-writer file, without a case-name filter or skip.
Packet receipt SHA256 is
`cf273db82981e6f40af081dea2dd352655d22086a2c9f1226114a0805cd0d6c4`.

That single invocation passed whole API types and the exact inherited-warning
audit, preserving raw strict exit1/audit exit0 with 56 exact warnings and no new
warnings, errors or suppressions. Actual Jest output reports one file and all
eight cases passed, with zero failures or pending cases. The strengthened
single/all promotion and quick-tag cases therefore exercised the real Mongo
commit, changed persisted labels, retirement during the attempt and the same
post-commit error. No broader 28-file replay or retry was performed.

Retention receipt SHA256
`b03a4a8d4ff92cedcc10f41d87a726a930493c5dbd13843a5db7bbdef620dc3f`
records the actual 467 passing cases in 27 unchanged files from the earlier
Jest JSON, with case identities, source hashes and six raw context copies.
All eight old attribution-writer cases are excluded, including the six old
passes. The combined evidence is **467 retained plus eight fresh = 475 distinct
passing cases across 28 selected files**. Its SHA256 is
`d72f6567e842bba4afdb5e9a2e0d2e0bc2b08c212f64503ace5102155b0b854d`.

Full final guards passed all 941 inputs, 26,114 dependency pins, 217 retained
proof pins, the 12 warning-source pins, tools, tracked-clean c207/tree d9a4 and
the unchanged map seed4d525b8e. The captured runner and three recorded child
PIDs closed; no owned Mongo process or listener remained. Two other Node
processes created during the window were traced to separate Codex branches,
outside the captured runner tree, and left untouched. The final closure makes
no global process-zero claim. Its SHA256 is
`f2ba047423f78179b226578dd1094c48aeb7aaa055b9c270e2ee4f5ea74031bc`.
The runtime slot was released.

Raw result SHA256 is
`0163ed8d8c5af1409f800e2cf38c0e97cf929ea4a6d4629fd659b31d287a75be`;
fresh Jest JSON SHA256 is
`a0e79ee9ee13d2ea6df2103e81b639c39fd95612ad8d078cef4630485359c529`.
These records are retained under
`.cache/revision-cache-validation-c2075305-prep/runs/2026-10-26T19-50-56.219Z-d7870a5c-b747-40da-9107-4c8548f4c591/`.
Earlier source copies, failed-run reports and receipts remain immutable.

## Validation still required

Prepared tests cover flag-off baseline bodies/headers and zero new commands;
typed owner/filter/option isolation; six-only allowlist; auth/revoke/deletion and
GDPR guards; exact byte edges, LRU/TTL, pinned retirement/reservations;
queue/join/response/owner caps and cancellation; late fills; unknown write and
partial restore/recompute failures; and a real local Mongo revision predicate.
The selected evidence and focused repair validation are complete as recorded
above. Preserve the earlier failures and keep retained versus fresh case counts
separate. These selected cases do not establish a full API or CI pass.

The selected TrendsRequests/date-probe, visibility/GDPR, game controls/backups,
custom-build and intent guard/rollback, macro, filter and history neighbors ran
in the original invocation. Full API tests and CI remain pending beyond this
selected packet. Before deployment activation, complete those checks and verify
the single-instance/fully upgraded writer gate. Actual aggregation executions
on cold/repeat/after-mutation requests have not been measured; no percentage
or savings is claimed.

Nonblocking metric follow-up: malformed stored dataRev reads bypass retention
without incrementing revision_failure, which currently counts revision
persistence and invalidator failures. No product change is included for this
visibility gap.

Whole faster-dashboards remains incomplete: ETag/304/client support, broader
dependency-safe caching, maintained gameStats, latestAgent/device-token cache and
admin-health cache tile remain. analysis-corpus-local-cache is unchanged:
updatedAt/index/change/removal/version contract, IndexedDB and UI clearing gates
remain separate. No migration, production recompute, warmer, new infrastructure,
AI feature, release, install or service restart is included.
