# Device liveness — focused checks complete; integration remains for CI

Applied 2026-10-27 UTC in the NEW isolated checkout:
C:\Users\jay19\.codex\worktrees\wave5-device-liveness\SC2TOOLS.
Branch: codex/wave5-device-liveness.
Base: a0681fd88a973cb690a956a5c89930e7c01ee9c9;
base tree: e51dad6637860819438c7b0f11e5a475d998200e.

Root applied the reviewed revision2 nine-path source and the separately reviewed
Foundation lifecycle fixture as the tenth path. Raw copies were verified against
the frozen proposals. Evidence is preserved in
C:\SC2TOOLS\.cache\device-liveness-applied-a068-revision2\receipt.json
and foundation-applied.json. Frozen V1/V2 proposal bytes remain separate evidence.
The ten paths were frozen at ae0a6858b2b4f7c72eafe2b673597007eaa1ce33,
tree af32fb370c9c01ce920749caa02d2c746c8a4de4. Whole-API types ran once
with exit 0. Strict lint of seven JavaScript owners exited 1 with zero errors
and twelve max-lines-per-function warnings. Four raw a068 stdin comparisons
confirmed the same twelve warning owners; root admitted exactly those owners.
Nine sizes were unchanged, makeServices grew 548→549, deleteAll grew 127→130,
and the outer Foundation describe shrank 258→253. The strict nonzero is retained;
new helper/tests and pairings were clean. No suppression or strict-pass claim.

The first focused run ran once: nine files, 105 cases, 78 passed, 27 failed,
zero pending. All 27 failures were beforeEach fixture setup at the new Mongo
file's line 22: two users without clerkUserId violated its real unique index
with duplicate null. Those 27 test bodies did not execute. The follow-up gives
the a/b and fifth-owner c/d/e seeds distinct deterministic synthetic Clerk IDs.
The fixture commit changed only those two insertMany seed expressions and this
checkpoint; no index, product/helper code, body assertion or test table changed.
The first RED and its raw failure remain evidence; the corrected Mongo file's
separate passing result is recorded below.

The ten applied paths are:

- apps/api/src/app.js
- apps/api/src/services/devicePairings.js
- apps/api/src/services/deviceLiveness.js
- apps/api/src/services/gdpr.js
- apps/api/__tests__/deviceLiveness.test.js
- apps/api/__tests__/deviceLiveness.mongo.test.js
- apps/api/__tests__/meFoundation.test.js
- docs/engineeringexplanation.md
- docs/handoff/device-liveness-checkpoint.md
- CHANGELOG.md

One projected active-token lookup remains on every auth request. Fresh REST calls
issue no touch; stale touches coalesce in four finite slots with an atomic
owner/id/hash/active/stale predicate and no upsert. Failed/unknown touches remain
nonfatal and retry from a later authoritative lookup. Heartbeat metadata, events
and callback still execute; literal monotonic date updates cannot move liveness
backward.

latestAgent retains cloned DTOs for an absolute 30 seconds within 1024 owner
states, four cache-owned tasks and 16 coalesced subscribers per task. Retained
UTF-8 owner keys, touch keys and DTOs share the unchanged 512 KiB budget; a DTO
entry is at most 16 KiB. Empty, negative, pending and active owners are charged
from creation. A detached task pins its owner key until IO and subscribers settle.
Oversize versions remain complete and skip retention. No timer or retry queue.

Root selected CACHE publication/reuse coherence, not strict rejection of delayed
metadata responses. Capacity, active mutation and overflow use exactly one
ordinary projected latestAgent query per uncached request, with no retention or
coalescing. Four is a cache-owned task bound, NOT a limit on baseline HTTP queries.
An already-issued read may return its original DB snapshot after a known mutation,
as it could before caching; it cannot refill or join a fresh cache generation.
Auth stays a fresh lookup and is never authorized by this metadata cache.

Issue, touch, heartbeat, both revokes and actual app/GDPR account erasure bracket
possible writes, including exclusive-fence acquisition and unknown outcomes.
These cache fences operate with UserCache OFF and ON.

The focused source inventory declares 105 cases on this fresh a068 branch:
65 existing and 40 new. The two new files declare 13 helper/lifecycle plus
27 real-Mongo/service/app/HTTP cases. Actual /me declarations cover five cold
owners with four held cache loads, plus held ordinary touch and heartbeat overlap,
requiring honest 200 metadata without a new capacity/mutation 503. Helper tests
independently sum retained keys/DTOs and cover eviction and retired snapshots.

Foundation retains all 13 cases, all 65 original expect source lines and hook
ordering. Its fixture now captures the real pairings service, uses start/claim/poll
to issue a device, derives its SHA256 token hash, records the real heartbeat and
revokes the device for cleanup. There is no cache clear, lifecycle mock, assertion
waiver or added wait. Tours' later 11 Foundation additions are separate and are
not included in this branch's 105 declarations. The 65 existing cases, including
all 13 Foundation cases, and the 13 pure-helper cases passed on ae0. Those 78
passing cases remain tied to ae0. The corrected Mongo seeds and their 27 cases
were validated separately at cd663, as recorded below.

Validation receipts are preserved under
C:\SC2TOOLS\.cache\device-liveness-validation-ae0a6858-v2:
static-results-seal.json and focused-results-seal.json. Every stage's pre/post
61 raw pins matched, including own/primary seeds, tools/binaries, junction and
absent generated paths; the ae0 source remained clean. The focused run used
system Mongo7.0.14, downloads disabled, runInBand and unchanged test timeouts.
Its independent normalized Time6 closure retired all 21 observed identities,
including eight Mongo identities, with zero owned listeners and no PID reuse.
No retry was run. The runtime slot was released for Tours.

The fixture correction was committed at cd663be4dff80837a33c2ae7502c1bc6f27c6678,
tree 58218727299c29ae8cee2a72a402819eb6ef0595. Changed-file strict lint ran
once: exit 0, zero errors and warnings. Only deviceLiveness.mongo.test.js then
ran once: 27 passed, zero failed/pending, one file, exit 0. It used the same
pinned system Mongo7.0.14, no downloads, runInBand and unchanged test timeout.
There was no repeat of types, the seven-file lint, four baselines or 105 cases.

Follow-up evidence is preserved in
C:\SC2TOOLS\.cache\device-liveness-validation-cd663be4\receipt.json
and results.json. Both pre/post 61-pin guards matched the clean cd663 source,
protected own/primary seeds, tools/binaries, junction and absent generated paths.
Both independent normalized Time6 host closures passed: lint's five identities
and the focused run's seven identities, including one Mongo identity, were all
retired with zero owned listeners and no observed PID reuse. Final closure was
2026-10-27T01:52:11.4937733Z. No retry or source/Git edit occurred during checks;
the runtime slot was released for Tours browser work.

These results remain bound to their exact source commits: 78 passes, types exit 0
and raw seven-file lint exit 1 with twelve admitted inherited warning owners at
ae0; changed-file lint and 27 Mongo passes at cd663. No single 105-case green run
or measured speedup is claimed. Integration with current main and the whole-API
suite remain for CI; local runtime authorization does not extend to either.

ETag/browser reconstruction, 60-second auth reuse, broader route caching,
maintained gameStats and admin-health presentation remain separate. Corpus
deltas/IndexedDB, production activation, new indices/migrations/dependencies,
provider/native work and budget increases are outside this pack.
