# Opt-in personal chart cache: source checkpoint

2026-10-26. Base provided by the parent: `9a68c480c9d19278642b5c546fe4b3ab081fa6b1`,
worktree `wave3-guides-expansion`, branch `codex/wave5-revision-chart-cache`.
Initial preparation was source only. Later authorized whole-API type and strict
lint runs are recorded below. No test, build, generator, Git mutation, browser,
provider, database or production activation was performed by this author.

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

The 31 paths comprise:

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
exact delta against the original source receipt. All repair tests remain unrun.

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
Liquipedia-only setup is a global provider deny rule. Remaining actual selected
provider paths are being traced before a future validation grant.

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
paths stay unchanged. Annotation validation is pending independent review,
parent preservation and a new exact runtime grant.

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
new any type or cache behavior is added. This extraction is source-only and
awaits independent review, parent preservation and a fresh validation grant.

## Validation still required

Prepared tests cover flag-off baseline bodies/headers and zero new commands;
typed owner/filter/option isolation; six-only allowlist; auth/revoke/deletion and
GDPR guards; exact byte edges, LRU/TTL, pinned retirement/reservations;
queue/join/response/owner caps and cancellation; late fills; unknown write and
partial restore/recompute failures; and a real local Mongo revision predicate.
They have **not been run**. Independent source review and a parent-serialized
runtime slot are still required. Preserve any inherited failure evidence.

After focused suites, run existing TrendsRequests/date-probe, visibility/GDPR,
game controls/backups, custom-build and intent guard/rollback, macro, filter and
history regressions, then API lint/types/full tests as authorized by the parent.
Measure actual aggregation executions on cold/repeat/after-mutation requests.
No performance percentage or passing result is claimed here.

Whole faster-dashboards remains incomplete: ETag/304/client support, broader
dependency-safe caching, maintained gameStats, latestAgent/device-token cache and
admin-health cache tile remain. analysis-corpus-local-cache is unchanged:
updatedAt/index/change/removal/version contract, IndexedDB and UI clearing gates
remain separate. No migration, production recompute, warmer, new infrastructure,
AI feature, release, install or service restart is included.
