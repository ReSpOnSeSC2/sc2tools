# ADR 0072: Serving-cohort coherence for retained chart and credential state

Status: Accepted contract, October 30, 2026. Documentation plus one source-inventory
test. It changes no runtime behavior, flag, provider or infrastructure, produces
no receipt and activates nothing. `USER_CACHE_ENABLED` stays off and
faster-dashboards remains partial.

Source paths are relative to `apps/api/src/` unless they start with `apps/` or
`docs/`. Line numbers were checked at slice DA4's tested source (`90126ee2`).
The ADR was added at application source `27b9aeb0`. C1 through C4 changed the
cited allowlist lines in place and edited route and service lines without
changing line counts (C4's route and curve helpers follow the cited lines), and DA2
added lease lines after the cited ones, so every citation still resolves. DA3 adds only tests. DA4 inserts the disable method above the writer helper, whose citations now read 224-228.

## Context

Two retained-state features are built but inactive: the default-off per-user
chart cache, which covers twenty-one response kinds in source, and the uninjected
retained device-auth REST adapter. Both keep their state in one process. The
roadmap allows wider cache coverage only after "complete dependency/revocation
and shared-fleet audits" (`docs/handoff/roadmap-progress-2026-10-28.json:1963`)
and requires "an explicit serving-process/rolling-overlap revocation contract"
for device auth (`:1966`). ADR 0071 still defers the real clock, election and
cross-process assumptions (`docs/adr/0071-device-credential-readiness.md:56-57`),
and the engineering explanation requires fleet and out-of-band writer coherence
before the flag is enabled (`docs/engineeringexplanation.md:399-403`).

ADR 0071 keeps the device-credential activation and rollback prerequisites
(`docs/adr/0071-device-credential-readiness.md:51-62`). This ADR is the home for
the fleet model, the cross-process inventory, the chart-cache guarantees and
admission checklist, the transcribed ordering, clock and deployment rules, the
operations forbidden while retention could be active, and the activation
receipts. It narrows ADR 0071's rollback rule to writers at or after `b8608d90`,
and a change to either rule updates both in the same pull request. It records
what holds today, what does not and what a later slice must prove. It is never
cutover, activation or savings evidence.

## Fleet model

The API is one Render web service pinned to one instance (`apps/api/render.yaml:31`)
with `autoDeploy: true` and a `/v1/health` health check (`:18-19`). The pin
exists because Socket.io, LiveGameBroker and the rate limiter keep their state in
one process; scaling out first needs a shared store (`:20-30`). The blueprint
sets no shutdown delay. The live instance count, autoscaling, session affinity,
shutdown delay and flag value are dashboard settings, so the operator verifies
them; the repository cannot.

One instance is not one process. Every deploy starts the new process while the
old one still serves; `jobs/reviewDigestJob.js:12-17` already treats that brief
two-instance overlap as a real case, and a Live service page does not prove that
only one process serves (`docs/handoff/device-auth-reuse-checkpoint.md:281-283`).
A restart and a flag change also start a new process: `USER_CACHE_ENABLED` is read
once at boot (`config/loader.js:151`) into that process's own `UserRevision` and
`UserCache` (`app.js:394-396`). Every deploy, restart and flag change is therefore
treated as an overlap window, and none is qualified today. The health check
proves only a Mongo ping and write (`routes/health.js:60-79`), not the serving
cohort.

On SIGTERM the server would first retire an injected REST credential reuse
adapter, before any await; none is injected today (`server.js:419-421`). The
listener keeps accepting requests, including retained cache hits, while three
stops are awaited (`:424-426`). HTTP then closes with an 8-second grace
(`:433-448`), and the remaining stops run one after another (`:450-486`). There is
no overall deadline and no error handling (`:413-414,417-487`), and the
process-level rejection hook only logs (`:62-71`). A stop that rejects therefore
skips the remaining drains and the exit, and the process lives until the platform
kills it. A rejection at `:424-426` also leaves the listener open, so the old
process keeps serving reads, retained hits and writes until then. Nothing in
shutdown touches `UserCache`.

The only retirement bound the program has adopted is the conservative published
300-second shutdown bound in ADR 0070 (`docs/adr/0070-maintained-account-statistics.md:80-86`).
This ADR uses the same figure for both consumers below as an **assumed provider
bound**, not proof: the repository does not enforce it. A receipt observes the
predecessor's retirement rather than assuming it; the exit of any older process,
such as one kept alive by a rejected stop, rests on the assumption unless the
receipt observes it.

A multi-instance service, autoscaling and session affinity are unqualified. The
blueprint configures none of them (`apps/api/render.yaml:31-36`), and the
operator advisories report a configured multi-instance or autoscaled service as
not ready (`services/infrastructureAdvisories.js:338-349`). That advisory reads
the configured count and cannot see a deploy overlap. Any such change voids this
contract until it is revised.

## What crosses a process boundary

The table covers state read by covered chart kinds or device-credential paths,
and the realtime state behind the one-instance pin. Each row has one of five
classes, and the last column bounds how long it can disagree with a peer:

- **Durable fencing** is a durable row read or written with majority or
  transactional semantics. Only this class, or a local lease derived from one of
  its majority-acknowledged grants, can authorize work that must hold against a
  peer's credential or semantic write.
- **Durable advisory** is a durable value or wall-clock lease that each process
  reads for itself. A change retires local state or blocks a claim; it never
  proves freshness or authorizes on its own.
- **Local lease** is process-local permission derived from one
  majority-acknowledged grant. It is valid only before the grant's elapsed-clock
  deadline and only under the clock contract below.
- **Local reuse** is process memory that answers requests within a stated bound.
  A peer's write stays invisible to it until the bound passes or it observes a
  durable advisory change.
- **Local state** is process memory with no cross-process bound, such as deny-only
  marks, rooms and rate windows.

| State | Source | Class | Cross-process bound |
| --- | --- | --- | --- |
| `UserRevision` tokens, process epoch, owners, dirty and poisoned marks | `util/userRevision.js:11-21` | Local state | None; peers never see them, and the marks can only deny reuse locally |
| `users.dataRev` | `util/userRevision.js:61-88,109-139` | Durable advisory | Re-read by every guarded request. A higher value retires; equality never proves freshness, and a first observation adopts it unchecked (`:126-131`). A flag-off process never bumps it (`:55,102`) |
| `UserCache` entries and ETag salt | `middleware/userCache.js:10-12,19-33` | Local reuse | 600 s after storage (`:11,222-223,269`), plus the computation's duration and any adopted join age |
| TrendsRequests in-flight joins | `services/trendsRequests.js:4-5,21-28,76-84` | Local reuse | 30 s; the join key carries no revision (`:79`). Covered kinds share the curve-independent `dateRange` key (`services/aggregations.js:634`) with unguarded HEAD and coaching callers, and work under a captured curve proof never joins the matchup time series key (`services/aggregations.js:680-683`) |
| `cached()` completed memo (random summary only, and only while the chart cache is off) | `services/trendsRequests.js:42-67`; `services/aggregations.js:360-362`; `routes/aggregations.js:110` | Local reuse | 60 s. A cache-enabled process never fills or consults it, so no retained body can adopt it |
| Momentum session-policy reuse gate | `services/sessionResolutionGate.js:14` | Local reuse | 15 s |
| MMR curve memo and snapshot epoch | `services/mmrExpectation.js:10,84-89`; `services/strengthCurveSnapshots.js:13-27` | Local reuse | 60 s; the five dependent kinds' entries expire with their proof (`middleware/userCache.js:268-270`), and their HEAD and flag-off requests keep the original memo reads |
| Device touch dedupe and 30-second latestAgent reuse | `services/deviceLiveness.js:6,75-91,101-118` | Local reuse | 30 s; the minute touch filter itself is durable (`services/deviceAuthTokenRead.js:37-44`) |
| Overlay-token resolve cache | `services/overlayTokens.js:60-61,88` | Local reuse | 10 s; a token revoked on a peer still resolves here until then, because a revoke evicts only the local entry |
| `DeviceAuthReuse` and `DeviceAuthLease` grants (uninjected) | `services/deviceAuthLease.js:8,48-77`; `services/deviceAuthReuse.js:10-11,139-141` | Local lease | 1.8-second grant; 60-second entries need the current incarnation and generation |
| `DeviceAuthLease` failed-probe hold-off (uninjected) | `services/deviceAuthLease.js:20,50,94-96` | Local state | None needed: it is deny-only, withholds grants for 1.8 s after a probe settles without one, and holds no token or authority value |
| Credential authority record in `jobLocks` | `services/deviceCredentialWrites.js:7,12,90-133`; `services/deviceCredentialPreparation.js:38-45` | Durable fencing | Majority writes; 2.1-second writer drain |
| `gameStatsMutationEpoch` and `_gdprMutation` | `services/gameStatsWrites.js:89-93,147-154`; `services/gameStatsMaintenance.js:88-97,103-106` | Durable fencing | Checked inside majority snapshot transactions |
| GDPR repair liveness handle | `services/gdprRepairLiveness.js:15-19,80-97` | Local state | None; deny-only, and it cannot see lease expiry or loss in another process |
| User-data write fence lease | `middleware/userDataWriteFence.js:4,13-27,50-56` | Durable advisory | 15-minute lease on the claimant's wall clock, renewed every 60 s until release, response close or a failed renewal. An abandoned lease blocks GDPR claims for at most 15 minutes after its last renewal, as the GDPR process's wall clock judges the claimant's stamp, so clock skew adds to it (`services/gdpr.js:1331-1334,1373-1379`). Admitted requests are not re-checked, and it never touches `dataRev` |
| Generic job-lock leases | `util/jobLock.js:4,63-70,80-86` | Durable advisory | One lease, stamped from the holder's wall clock and judged against the acquirer's. The holder re-checks only between steps and its writes carry no owner condition, so a holder paused past expiry can overlap its successor. Never authorizes |
| Socket.io rooms, LiveGameBroker and rate-limit stores | `server.js:89-95`; `services/liveGameBroker.js:22-27,96-140`; `middleware/boundedRateLimitStore.js:12-14` | Local state | None. The pin prevents only a steady-state split; every deploy, restart or flag-change overlap splits rooms, live snapshots and rate-limit windows until the old process closes HTTP and Socket.io (`server.js:432-435`), or, if an earlier stop rejects, until the platform kills it |

No invalidation broadcast and no durable record of serving processes exist.
Retained keys contain process-local parts, the process epoch and token ids
(`middleware/userCache.js:257`), so retention must stay per process.

One authorizing process-local set is outside this contract and has no bound: the
admin allowlist. Database admins are merged into it once at boot, and a revoke
removes the entry only in the process that served it (`app.js:344,1417-1420,1601`;
`server.js:125-127`; `services/adminRoles.js:23,27`). A revoke served by the old
process during an overlap stays authorized on the new process until it restarts.

## Chart-cache guarantees

| | Guarantee | Today | Evidence |
| --- | --- | --- | --- |
| G1 | Every writer of a covered input invalidates retained bodies | Met only inside one flag-on process running the current writer set. Unmet for flag-off processes, older writer sets during an overlap, out-of-band migrations, manual edits and raw restores | In-process writers call `gameWrite` (`util/userRevision.js:163`; `docs/engineeringexplanation.md:408-412`); flag-off processes skip revision work (`util/userRevision.js:55,102`); `db/migrations/2026-09-30-rename-8-pool-builds.js:50,115-119` rewrites build and strategy labels with a plain `updateMany` |
| G2 | Revision uncertainty is visible across the fleet | Unmet | A failed, unknown or skipped bump marks only the local owner dirty (`util/userRevision.js:69,86-88`) |
| G3 | In-flight writes are visible across processes | Unmet | The bump runs after the semantic write and outside its transaction (`util/userRevision.js:61-85`); until a peer reads it, the peer can serve or 304 the prior body |
| G4 | Staleness has a time bound | Met per process | Entries leave the cache 600 s after they are stored (`middleware/userCache.js:11,123,222-223,269`), and curve-dependent entries with their proof (`:268-270`). A body's data can be older by the computation's duration and the age of an adopted join: under 30 s per join, and under 60 s when an adopted chart join itself adopted the shared `dateRange` probe. Chart pipelines set no deadline beyond the 30-second Mongo socket timeout per round trip (`db/connect.js:103`; `config/constants.js:288`). This is the only bound on the G1 and G2 gaps, and on G3 when the bump fails |
| G5 | A validator never matches stale state from another process | Met for opaque tags only | Tags use a per-process salt and epoch (`middleware/userCache.js:31,219,257`; `util/userRevision.js:15`), so a peer's tag gets a full 200. `If-None-Match: *` matches any retained entry (`middleware/userCache.js:299`) |
| G6 | Deleted or GDPR-locked owners are never served | Met | Each guarded request re-reads the durable rows (`util/userRevision.js:119-125`) |

A process that observes an owner for the first time, or again after the
4096-owner eviction (`util/userRevision.js:44-50`), adopts the stored `dataRev`
without retiring anything (`:126-131`). It keeps everything the invalidator would
retire (`app.js:1004-1007,1011-1019`): the owner's in-flight TrendsRequests joins
and the session-policy reuse. Any caller that skips the guard can seed that state:

- HEAD requests (`middleware/userCache.js:109-111`);
- coaching's MMR progression and net MMR by matchup (`routes/coaching.js:570-583`).
  The net-MMR call's join key equals a guarded `/v1/mmr-by-matchup` request's for
  the same owner when that request sends `map_pool=ladder`, `game_size=1v1`,
  `group_by=matchup`, the same other filters and a `tz` string identical to the
  zone coaching passes (its trimmed, valid `tz`, else `UTC`). The guarded route
  keys `tz` raw, so an omitted or padded `tz` never matches
  (`routes/coaching.js:560-569,857-866`; `routes/aggregations.js:340-341`;
  `services/aggregations.js:749`; `services/trendsRequests.js:126,129`);
- the shared `dateRange` probe (`services/aggregations.js:631-645`), which the
  covered timeseries, MMR progression, map trend and matchup time series adopt
  (`services/aggregations.js:474`; `services/trendsInsights.js:92-93,806-807`;
  `services/trendsAggregations.js:42-44`). Its key is the owner-scoped match
  alone, with no interval, `tz` or curve, so a HEAD to any of those routes, or
  coaching's MMR progression, seeds it for a guarded request with the same parsed
  filters. It reads no global input. Apart from the unguarded callers listed here,
  no uncovered kind shares an inner key with a covered kind;
- session-policy reads without a known value, which share momentum's reuse key
  (`services/sessionPolicy.js:47-48,74`): `routes/me.js:235`, and the session list
  and detail (`routes/sessions.js:17,19`; `services/sessionHistory.js:92,99`).

A first-observation request can therefore adopt a join up to 30 seconds old,
whose inner `dateRange` input can be up to 60 seconds old, that began before
another process's write, then retain its result for up to 600 seconds. A later observation of a higher `dataRev` retires locally and answers
that request with a 503 and `Retry-After: 1` (`middleware/userCache.js:118-120,156-158`).
New kinds inherit this and every row above.

## Source-coverage admission checklist

A response kind may join the allowlist (`middleware/userCache.js:7-9`) while the
flag stays off only when a reviewer can tick every line with file:line evidence
at the pull request's head, and the pull request description states what items 8,
9 and 11 require. Admission wires an unchanged computation: items 1, 2 and 4
already hold at the base, and so does item 3 unless the kind must stop using a
completed memo whenever the cache is enabled, which leaves the calculation
itself unchanged (random summary, slice C3). A kind with a global input meets
items 1 and 6 only on its proof path: the computation takes the input from the
captured proof, while paths that are never retained, HEAD and the flag-off path,
keep the original read (matchup time series, slice C4).

1. **Owner games only.** Every database read in the computation is on `games`,
   is scoped to the owner's `userId` and uses `gamesMatchStage(userId, filters)`
   (`util/parseQuery.js:240-247`) to select every row the response counts. It
   normally starts with that stage. A read that first scans a wider set of the
   owner's rows, as the net-MMR pairing window does with
   `{ userId, isResumedFromReplay: { $ne: true } }` before `$setWindowFields`
   (`services/trendsNetMmr.js:95,130-150`), lets rows the stage excludes
   (quarantined, hidden, pending-deletion, tombstoned and out-of-filter rows)
   affect the response only through fields named with file:line evidence: their
   window membership, partition and sort order, and the values `$shift` copies
   into counted rows. Item 2 covers those fields on those rows. The macro report's
   date-extremes pre-pass, admitted in C1 under the earlier wording, is the other
   wider read: it replaces any `macro_min`/`macro_max` range with a type test
   (`services/macroReport.js:107-122`; `util/parseQuery.js:288-295`), so `date` and
   `macroScore` on scored rows outside the range set the trend split, while the
   owner, deletion and exclusion clauses stay; those fields' writers are fenced
   (`services/perGameCompute.js:498`;
   `apps/api/__tests__/userCacheStreakMacro.mongo.test.js:42-70`). There is no
   `$lookup`, `$unionWith` or other collection. A captured proof's memo read
   happens before the key is formed (`middleware/userCache.js:115,274-278`), so
   it is not a read in the computation.
2. **Fenced writers.** Every field it reads, filter fields included, is written
   only inside `gameWrite` or `UserRevision.run` (`util/userRevision.js:98-106,163`),
   or, when a new kind is admitted, is already read by a covered kind on the same
   rows. A field the computation reads, other than through the stage's own
   predicate, on rows that `gamesMatchStage` excludes, or read by no covered kind,
   needs its own writer evidence. Out-of-band writers stay G1 gaps.
3. **No completed owner-data memo.** An inner memo of owner data must be retired
   by the `UserRevision` invalidator (`app.js:1004-1007,1011-1019`;
   `services/trendsRequests.js:31-36`). A completed-result memo disqualifies the
   kind even when that invalidator retires it, because a first observation keeps
   it, widening the 30-second join window to the memo's lifetime, unless the
   computation skips the memo whenever the cache is enabled. Random summary does:
   its route passes `memo: false` under an enabled cache, so its 60-second
   `cached()` answers only while the cache is off (`routes/aggregations.js:110`;
   `services/aggregations.js:360-362`; `services/trendsRequests.js:42-67`). Item 6
   governs a memo of a global input and any in-flight join whose result depends
   on one.
4. **No clock in the result.** No value derived from the current time (`Date.now`,
   `new Date()`, `$$NOW` or a relative window) reaches a query, pipeline or
   response body. Timers that only age joins or expire reuse are exempt, such as
   TrendsRequests join aging (`services/trendsRequests.js:75-78`) and the curve
   memo's expiry behind item 6 (`services/mmrExpectation.js:84-89`).
5. **Other collections only before admission.** A route-level read of another
   collection is allowed only when its result is part of the key and checked by
   a publish guard, as momentum's session policy is (`routes/aggregations.js:224-235`).
6. **No unproved global input.** A global input needs a captured proof that drives
   both the key and the calculation, as the five dependent kinds do
   (`services/strengthCurveSnapshots.js:43-47`; `middleware/userCache.js:268-270`).
   Work that depends on the input either keys its join by the proof or skips the
   join whenever a proof is supplied, as matchup time series does
   (`services/aggregations.js:680-683`); a join that reads no global input, such
   as `dateRange`, may stay shared.
7. **Complete key.** Every request input is parsed before admission and passed as
   filters or options.
8. **Size.** Typical bodies fit the 512 KiB entry cap (`middleware/userCache.js:10`),
   and the pull request says whether the size is structurally bounded. Larger
   bodies go out as an uncached 200 (`:211-217`).
9. **Callers.** The pull request lists every caller of the kind's service method.
   A caller outside `send(kind)` of a method that runs through TrendsRequests is
   removed or named as an unguarded first-observation source, as HEAD and
   coaching are above. The route uses the app-level instance whose joins the
   invalidator retires (`app.js:1004-1007`). Several web callers of one path are
   fine, because each reaches the same guarded route.
10. **Wiring.** The route uses `send(kind)`, the kind is in `ALLOWED_ROUTES`, and
    the off path stays byte-identical (`routes/aggregations.js:26-28`;
    `middleware/userCache.js:109-111`). The web list appends the path without
    moving existing positions, because each position is a capability bit, and
    holds at most 32 (`apps/web/lib/conditionalApiScope.tsx:5-9,57,67`;
    `apps/web/lib/clientApi.ts:107`; `apps/web/lib/conditionalApiResponses.ts:96`).
11. **Fleet note.** The kind adds no process-local state, retained-key part or
    unguarded caller beyond the rows above, so it inherits G1-G6 and the
    first-observation rule unchanged; the pull request shows this with file:line
    evidence.

Items 1-10 are the per-kind dependency and revocation audit. Item 11 binds the
kind to the shared-fleet audit recorded in the three sections above. G1-G3 stay
unmet: chart-cache activation never meets them and covers them only through the
receipt rows under Activation receipts. Together these are the audits the
roadmap requires before source coverage grows
(`docs/handoff/roadmap-progress-2026-10-28.json:1963`). They qualify source
coverage only while the flag stays off and are never activation evidence.

## Device-credential contract

### Actors

| Role | Writer | Coordinated |
| --- | --- | --- |
| Issue | `services/devicePairings.js:178-238` | Yes, `issue` |
| Revoke by hash | `services/devicePairings.js:344-349` (no production caller) | Yes, `revoke-hash` |
| Revoke by id | `services/devicePairings.js:364-376` | Yes, `revoke-id` |
| Erase | `services/gdpr.js:386-390,438-455` | Yes, `erase` |
| Touch | `services/deviceAuthTokenRead.js:39-45` | No: metadata |
| Label | `services/devicePairings.js:379-387` | No: metadata |
| Heartbeat | `services/devicePairings.js:427-435` | No: metadata |
| Connection marker | `services/devicePairings.js:442-445` | No: metadata |

Erasure is reached from `routes/me.js:776`, from `routes/clerkWebhook.js:87`
through `services/gdpr.js:588-594`, and from the identity-deletion retry wired at
`app.js:897`. The coordinator wraps erasure whenever the context has a device-token
collection (`services/gdpr.js:150`). Snapshot restore excludes device tokens
(`services/userBackups.js:15`).

Metadata writers never write a credential authority field and never upsert. An
authority field decides whether a token authenticates or which owner and device it
resolves to: `tokenHash`, `revokedAt`, `userId` or `_id`
(`services/deviceAuthTokenRead.js:35,46`). Touch and heartbeat do write
`lastSeenAt`. The lookup projects it (`:52`) to schedule the minute touch
(`:37-45`), and the uninjected reuse path uses it only to end a retained entry
early (`services/deviceAuthReuse.js:130-136`); an entry's 60-second lifetime is
fixed when it is loaded (`:185-190`). The 30-second latestAgent memo
(`services/deviceLiveness.js:6,101-118`) is not an input to credential reuse.

`apps/api/__tests__/deviceCredentialWriterInventory.test.js` checks the source
against its own copy of this table and fails closed. It resolves direct
properties, element access, `collection(...)` calls, block-scoped local aliases,
destructured bindings, assignment patterns and reassignment, and it fails on:

- an unclassified file naming the collection or an exported list that names it,
  including a list derived from one;
- any other use of the collection, such as a new writer, hand-off or escape;
- a read that could write, such as an `$out` or `$merge` stage or a TTL index;
- any `$out` or `$merge` stage name, on any receiver, or any `var` declaration in a
  classified file;
- an unresolved write, aggregation or database-level command in a classified file
  outside its listed loops, parameters and command documents;
- an authority write that is not awaited inside the coordinator, directly or
  through an allowlisted wrapper, for the same top-level owner, bound by
  declaration from the coordinator's owner to the inserted document;
- a metadata writer whose literal `$set` writes anything but metadata fields, or
  which may upsert.

It is lexical evidence, not a runtime, failover, clock or separate-process proof.
It cannot see manual edits, raw restores, code outside `apps/api`, names built at
run time from non-literal parts (stage names included), iteration over the whole
database context or the `COLLECTIONS` or schema registry, a collection reached
through a parameter of a function in an unclassified file, or a mutation of an
owner object (`Object.assign`, `delete` or a mutating helper). It does not read
this ADR, so this table and its citations stay in step by review.

### Transcribed reviewed design

The ordering argument, clock contract and deployment rules below are transcribed
verbatim from the reviewed design
`C:/SC2TOOLS/.cache/device-auth-mongo-lease-design-20261028.json`
(SHA256 `d7f9770a918f48672fc77856c35e666e8769ca8bb34f953da9e6837d3ca15ec2`),
lines 83-100 and 246-251. Its independent review,
`C:/SC2TOOLS/.cache/device-auth-mongo-lease-independent-review-20261028.json`
(SHA256 `36f4b3a74cda02c51545df0fb6138875be328a9315ecb98029cba9f4bd611bde`), is a
conditional source-only clearance with no requested text changes. Both are pinned
to source `7b9a30a2`; the text is transcribed as reviewed there, not re-reviewed
against current source. Run-together tokens are the file's own bytes, and
`exampleConstants` is the same object re-serialized on one line. The
transcription adds no protocol.

Ordering argument and clock contract (design lines 83-100):

```text
formalArgument.premise: All serving actors use the SAME durable authority doc/protocol/namespace. Each valid grant is an actual majority-ACK same-doc write. Each writer gate is a majority-ACK same-doc mutation ordered with all grants. Monotonic clocks obey the explicit elapsed-time bound below.
formalArgument.notation: C=grant linearization;S=local grant request start;P=writer pending linearization;A=its ACK receipt;B=max actual valid-reader lifetime measured fromS;W=writer real wait afterA, chosen strictly>B;M=credential mutation dispatch;K=successful response ACK.
formalArgument.orderBeforeGate: If C<P then S<=C<P. Grant expires byS+B<P+B<=A+B<M because writer waitsW>B afterA. Thus this grant cannot admit a reused result after mutation dispatch orK, regardless of held response/network delay.
formalArgument.orderAfterGate: If P<=C while gate remains pending, the atomic grant snapshot denies the affected owner (or all owners). It cannot authorize cached reuse for that owner. Completion advances generation only after actual acknowledged credential work, so a post-completion grant cannot reuse an older-generation entry.
formalArgument.heldLookups: A lookup that began under old generation cannot be published/rebound after invalidation; final synchronous guard rejects expired/retired tickets. A fresh independent authoritative fallback has existing snapshot semantics and is explicitly excluded from the stronger cache guarantee.
formalArgument.failover: Ordering depends on durable majority-ACK same-document mutations, not local/secondary reads. Unknown grants grant nothing; unknown pending dispatches nothing; unknown work keeps a gate. Tests must exercise primary change/late ACK; source review alone does not prove live replica behavior.
formalArgument.cachedEntryRenewal: A fully completed entry may survive multiple short grants for up to60s only when incarnation+generation remain exactly equal and owner remains permitted. Every protocol-covered credential write changes generation before work, so same-generation reacquisition is not a silent60s revocation window.
clockContract.required: Local elapsed-time source must advance across GC/event-loop stalls/process descheduling, remain monotonic/finite, and have a bounded rate relative to real elapsed time. A callback delayed by a stall may run late safely; no response timestamp may extend the original deadline. Clock anomaly invalidates grants and uses uncached auth.
clockContract.exampleConstants: {"readerLeaseMs": 1800, "writerDrainMs": 2100, "maximumAssumedClockRateError": 0.01}
clockContract.inequality: For reader slow-rate bound er and writer fast-rate bound ew require writerDrainMs/(1+ew)>readerLeaseMs/(1-er). Example1% bounds give actual reader<=1818.2ms and writer>=2079.2ms. Constants are proposed, not measured claims; use a justified margin rather than identical nominal2s clocks.
clockContract.limitation: No source-only protocol proves safety if a suspended host clock stops while authorization code later continues under an apparently unexpired grant. Verify chosen Node/OS elapsed-time behavior or combine conservative anomaly checks; do not advertise arbitrary-clock-failure immunity. Writer wall-clock/TTL arithmetic is not an acceptable substitute.
```

Two-phase deployment, rollback and manual-edit rules (design lines 246-251):

```text
twoPhaseDeployment[0]: Phase1: ship all real writers with this exact gate protocol while retained auth remains off and the authority document is prepared. All writers—including erasure/webhook retries and subsequent old/new rolling processes—must honor pending generations and unknown outcomes. Prepared mode grants no retained lease. No new environment/provider flag is required; protocol state is durable application metadata.
twoPhaseDeployment[1]: Collect actual all-writers-upgraded/old-unregistered-process-drained proof before activation. One configured Render instance, oneReady deployment or one PID source entry is insufficient. Initial legacy writer overlap remains a hard release gate.
twoPhaseDeployment[2]: Phase2: only after that proof, explicit reviewed activation CAS (expected protocol/namespace/incarnation/generation, no unresolved preactivation pending unless knowingly staying uncached) enables demand grants. Do not let each new process silently activate at boot or clear pending state. No activation is performed by this audit.
twoPhaseDeployment[3]: After activation, rolling overlap is safe for protocol-compliant actors because both grants and writers coordinate durably. Future incompatible protocol/namespace changes require a fresh prepared/all-writers cutover. Manual DB edits and scripts outside this protocol remain unsupported while retention active, or must first establish a denyAll drain barrier.
twoPhaseDeployment[4]: Rollback must retain writer gate protocol until grants are durably disabled and full old-lease bound drained. Deploying pre-protocol writers while another node can retain grants is unsafe. Disabling local cache only on the new node is not rollback coherence.
```

The source keeps the design's unconditional full drain (design line 75): every
credential gate drains in full (`services/deviceCredentialWrites.js:103-105`). The
candidate's own optional prepared-mode drain saving was dropped in source review
(`docs/handoff/device-auth-reuse-checkpoint.md:180-181`). One implementation
choice departs from the design. The design says never to delete or recreate the
authority record automatically and makes repair an authorized step (design line
44). A writer that finds the record missing recreates it in prepared mode
(`services/deviceCredentialPreparation.js:38-45`; `services/deviceCredentialWrites.js:48-52`).
This loosens the design. Recreation can lose the predecessor's unresolved scopes,
so a recreated record's empty pending list is not settlement evidence
(`docs/handoff/device-auth-reuse-checkpoint.md:107-115`). The departure is
accepted only because prepared mode grants nothing, every gate still drains in
full, and any activation needs a new binding to that incarnation
(`docs/adr/0071-device-credential-readiness.md:55-56`). The failed-probe hold-off
under Gates is not a departure: it adds no grant, every probe that runs is still
a new demand probe with a new start and deadline that must satisfy current
authority (design line 49), and a request without a grant runs the original
lookup (`middleware/auth.js:76-82`).

The constants in source match the design's examples: an 1800 ms reader grant
(`services/deviceAuthLease.js:8`) and a 2100 ms writer drain
(`services/deviceCredentialWrites.js:12`). The inequality is a proposed bound,
not a measurement, and the suspended-host-clock limitation stands. No immunity to
clock failure is claimed.

### Scope

Coherence holds only among protocol-v1 coordinated writers at or after
`b8608d90` (PR813). They obtain acknowledged prepared authority and pin the
readiness incarnation before dispatching credential work
(`docs/adr/0071-device-credential-readiness.md:16-21`;
`services/deviceCredentialWrites.js:95-96,224-228`). Writers from `df5cf875`
(PR807), and the releases that shipped that writer unchanged until PR813, are
pre-readiness actors. They gate and drain, and keep each operation on whatever
valid record their begin step found, but never check an incarnation obtained by
readiness. They must be retired before any activation
(`docs/adr/0071-device-credential-readiness.md:51-52`). Readiness adopts whatever
valid record exists, including one a pre-readiness writer recreated
(`services/deviceCredentialPreparation.js:38-45,62-68`), so a cutover cannot rely
on provenance. It retires old actors and settles their unknown work, then binds a
freshly read incarnation at a causal majority boundary with pending and `denyAll`
preserved (`docs/adr/0071-device-credential-readiness.md:51-56`).

While retention could be active, each of these needs its barrier first:

- **Deploying or rolling back to a commit before `b8608d90`.** Durably disable
  grants and drain the full old-grant bound (design line 251, transcribed above;
  `docs/handoff/device-auth-reuse-checkpoint.md:187-188`). Re-enable only after a
  new all-writers, old-actor proof and a reviewed activation CAS (design lines
  248-249).
- **Scripts outside this protocol and manual device-token edits.** A `denyAll`
  drain barrier (design line 250; `docs/handoff/device-auth-reuse-checkpoint.md:188-190`),
  which stays set until explicit settlement (design line 81;
  `services/deviceCredentialWrites.js:87-89`).
- **Raw restores and manual edits of the authority record.** The same barrier,
  then the design's authorized repair: a fresh incarnation and generation, with
  grants kept disabled and the old lease bound drained (design line 44). A
  restored or edited record can carry a rewound generation, mode or pending list,
  so a disable set before the write does not survive it (compare
  `docs/runbooks/restore-database.md:164-167`). No repair primitive exists yet.
  It must never mint the incarnation by deleting a live record so that a writer
  recreates it, because that insert resets pending and `denyAll`
  (`services/deviceCredentialPreparation.js:38-45`).

The durable disable primitive ships in source, owner-run and never invoked, but no authorized repair primitive exists yet, so retention must
not be activated before the repair primitive ships too.

Protocol changes keep `AUTHORITY_KEY` and the fail-closed filters
(`services/deviceCredentialWrites.js:7,72-79`; `services/deviceAuthAuthority.js:11-17`).
An incompatible change needs a fresh prepared, all-writers cutover.

The guarantee covers REST only. Sockets stay on the authoritative lookup
(`server.js:146-147`) and authenticate only at handshake
(`socket/auth.js:154-175`); revoking a device leaves its open sockets connected,
and only erasure disconnects them (`services/gdpr.js:573`). Requests already
admitted keep their baseline semantics. Metadata liveness reuse is not
authentication authority.

### Gates

| Gate | Today |
| --- | --- |
| Every credential writer coordinated on protocol v1 | Met in source since `df5cf875` (PR807); the inventory test checks placement lexically |
| Every coordinated writer pins the readiness incarnation before dispatch | Met in source since `b8608d90` (`services/deviceCredentialWrites.js:95-96,224-228`); not checked by the inventory test |
| Prepared startup observed | Met for one attempt only (`docs/adr/0071-device-credential-readiness.md:5-9`) |
| Serving cohort qualified, pre-readiness actors retired, same incarnation bound | Unmet (`docs/adr/0071-device-credential-readiness.md:51-55`) |
| Clock rate and suspension behavior verified | Unmet; the constants are proposed (`docs/handoff/device-auth-rest-reuse-helpers-checkpoint.md:89-91`; `docs/adr/0071-device-credential-readiness.md:56-57`) |
| Primary change and election behavior verified | Unmet (`docs/handoff/device-auth-rest-reuse-helpers-checkpoint.md:89-91`) |
| Separate-process evidence | Met in source for one revocation regression on one replica-set member, unwired: separate reader and writer processes, the reader's event loop blocked past the lease, and the held ticket, its second consume and the original lookup all refused after the writer's acknowledgement (`apps/api/__tests__/deviceAuthSeparateProcess.mongo.test.js:104-121`; `docs/handoff/device-auth-separate-process-checkpoint.md`). Election, clock-rate, suspension and multi-host behavior stay unmet under their own rows |
| Durable disable and rollback primitive | Met in source, owner-run and never invoked; the rollback rule requires one (`docs/adr/0071-device-credential-readiness.md:59-60`). `disable()` compare-and-sets the exact incarnation to the non-granting prepared mode with a fresh generation, keeps pending work and `denyAll`, and drains the 2.1 s old-lease bound after every write it attempts, before it reports or throws, including after an unknown write outcome and on a written record that fails verification (`services/deviceCredentialWrites.js:198-220`). The owner script dry-runs by default and writes only with the exact incarnation and `--apply` (`apps/api/scripts/disable-device-auth-retention.js:24-57`); no route, endpoint or flag reaches either. After a disable no lease grants and a ticket prepared earlier cannot be consumed (`apps/api/__tests__/deviceCredentialDisable.mongo.test.js:62-75`). A raw restore or manual edit can rewind the record, so those still need the repair row, and nothing deliberately sets `denyAll` (`services/deviceCredentialWrites.js:87-89,98`) |
| Authorized repair that mints a fresh incarnation | Unmet; the only source path that mints one recreates a missing record (`services/deviceCredentialPreparation.js:38-45`), which this ADR forbids as a repair |
| Failed-probe suppression | Met in source as a bounded rate, unwired. A probe that settles without a usable grant holds off new probes for one lease, timed from its actual settlement and re-armed after every failed probe; until then `acquire()` returns no grant with no dispatch and no wait, and a valid grant, `denyAll` included, starts no hold-off (`services/deviceAuthLease.js:20,50,94-96`; `apps/api/__tests__/deviceAuthLease.test.js:80-144`). It bounds the probes but does not remove them: under continuous demand an injected adapter facing a prepared, missing or unreachable record still sends at most one majority/journal `findAndModify` (a nonce write only when a row matches) per probe duration plus 1.8 s per process, and the caller that starts it, with up to 15 coalesced callers, can wait up to about 1.8 s. ADR 0071's statement that prepared metadata adds no grant probes therefore holds only while the adapter stays uninjected (`docs/adr/0071-device-credential-readiness.md:47-48`). Before step 2 under Activation receipts, the wiring slice must either accept this bounded rate in ADR 0071 and this row, or send no probes while the record is prepared |
| Reviewed activation CAS | Unmet (`docs/adr/0071-device-credential-readiness.md:49,56-57`; `services/deviceAuthLease.js:12-13`) |

## Out-of-band writers

While `USER_CACHE_ENABLED` is on in any serving process, or retained device auth
could be active, out-of-band writers are forbidden unless a named barrier runs
first. Out-of-band means anything outside the inventoried in-process writers:
migrations such as `db/migrations/2026-09-30-rename-8-pool-builds.js`, scripts
under `apps/api/scripts`, manual database edits and raw restores.

- **Chart cache.** Deploy with the flag off and let the old process retire under
  the assumed bound before the write. The flag is read once at boot and retained
  bodies live only in process memory (`config/loader.js:151`; `app.js:394-396`;
  `middleware/userCache.js:19-33`), so that deploy discards them. Turn the flag
  back on only with a fresh receipt.
- **Device credentials.** Use the barriers under Scope. Until the authorized
  repair primitive exists, the only compliant state is that retention
  is not active.

## Activation receipts

Neither enabling `USER_CACHE_ENABLED` nor activating retained device auth may rely
on this ADR. Each needs a fresh read-only receipt, taken for a scheduled
activation review. This slice produces none. A receipt is necessary, not
sufficient. Device-auth activation also needs every row of its Gates table met.
Chart-cache activation needs every chart-cache receipt row; G1-G3 stay unmet and
are covered only as those rows allow.

For the chart cache, activation is the flag-on deploy. For device auth, activation
is the reviewed activation CAS, never a deploy or a boot (design line 249,
transcribed above), in this order:

1. Ship failed-probe suppression, the disable primitive and the authorized repair
   primitive.
2. Inject `deviceTokenReuse` in a deploy while the record stays prepared, which
   grants nothing (`services/deviceAuthAuthority.js:11-17`).
3. After that deploy's predecessor has retired, take the receipt of the injected
   cohort.
4. Run the CAS with the receipt's protocol, namespace, incarnation and generation.

Any deploy, restart, flag change, fleet-shape change or out-of-band write between
the receipt and the CAS voids it.

Today's logs can supply only part of a receipt. Every line carries pino's default
`pid`, `hostname` and `time` (`server.js:51`), the only process-distinguishing
fields. A successful credential readiness check logs the source revision,
protocol, mode, capability and incarnation digest
(`services/deviceCredentialReadiness.js:100-108`); a failed check logs no
revision. The digest names the durable record, not a process. Shutdown logs
`shutdown_start` (`server.js:418`), `device_credential_writers_drained` (`:478`),
`game_stats_writers_drained` (`:483`) and `shutdown_complete` (`:485`). The flag
value is never logged. The admin tile reports Off, Not reported or Enabled for
whichever process answers (`util/adminCacheHealth.js:15-33`). No durable record
names serving processes.

| Field | Needed for | Source |
| --- | --- | --- |
| Serving revision and process identity | Both | Startup log lines; the deploy record |
| Fleet shape: exactly one configured instance, autoscaling and session affinity off, and the configured shutdown delay | Both | Owner-run dashboard read; the admin infrastructure overview can corroborate count and autoscaling (`apps/web/app/admin/components/InfrastructureOverview.tsx:296`). A missing multi-instance advisory is not evidence |
| Predecessor retirement: its `shutdown_start`, both drained lines and `shutdown_complete`, read at least 300 s after its `shutdown_start` | Both | Logs, plus an owner observation |
| Earlier processes: every other process in the retained logs and every earlier deploy or restart shows `shutdown_complete`; any that does not is named, and its exit rests on the assumed bound | Both | Logs and the event history |
| One cohort: no deploy, restart, flag change or fleet-shape change since the predecessor retired | Both | Owner-run read of the deploy and event history |
| Out-of-band freeze: none is running or scheduled, and none ran since the predecessor retired | Both | Owner attestation |
| Writer set: the review re-derives the writers of every covered input at the serving revision and cites them. Each in-process writer runs inside `gameWrite` with the app-level `UserRevision` passed in (`util/userRevision.js:163` runs the work unfenced without one) or inside `UserRevision.run`; this is item 2's first clause only. Any other writer is named as a G1 gap under the freeze, and an unfenced in-process writer fails the receipt | Chart cache | Repository review |
| Configured flag value and the admin tile reading | Chart cache | Owner-run dashboard read and the tile |
| Overlap guard deployed with its residual window accepted, or the full retention window accepted, for activation and every later overlap while the flag is on | Chart cache | Repository and review |
| Writer set: the serving revision contains every writer in the actor table, and the inventory test passes there | Device auth | Repository |
| Authority record: protocol, namespace, incarnation, generation, mode, pending and `denyAll` at a causal majority read | Device auth | Owner-run read |
| Readiness digest equals the read record's incarnation digest | Device auth | Log and read |
| Pre-readiness retirement: the last process older than `b8608d90` has exited | Device auth | Deploy history and that process's shutdown lines |
| Disable primitive, authorized repair primitive and failed-probe suppression shipped | Device auth | Repository |

A receipt describes one serving cohort and decays at the next deploy, restart,
flag change, fleet-shape change or out-of-band write. A decayed receipt supports
nothing. For the chart cache, activation is itself a deploy, and while the flag is
on every later deploy (each merge, under `autoDeploy: true`), restart or flag
change, including turning the flag off, is another overlap. Each is covered only
by the deployed guard below with its residual window accepted, or by an
activation review that explicitly accepts the full retention window for every
overlap while the flag stays on. That window is 600 s after the last retained
store, plus that computation's duration and any adopted join age. Turning the flag off is not a substitute, because flag-off
processes never bump `dataRev`. Device auth accepts no overlap window: after
activation, overlap is safe only among protocol-v1 actors (design line 250).

## Follow-on guard

Decided for the chart cache: the overlap guard slice has three parts. It needs no
new infrastructure and stays default-off.

- **Shutdown-start retirement.** A process stops serving and storing retained
  bodies when SIGTERM arrives.
- **Admission-time quarantine.** A new process retains a body only if its snapshot
  was taken after its quarantine ended and no inner join or memo it used began
  before that point. At quarantine end it performs one full local retirement, as
  `retire(null)` does (`util/userRevision.js:28-39`). The quarantine ends no
  earlier than every older process can have exited under two assumed provider
  bounds: the 300-second shutdown bound, and the delay from the new process
  becoming healthy until the platform signals its predecessor. A process cannot
  observe that signal, so the slice derives the start conservatively and
  justifies any margin, and its receipt observes the predecessor's
  `shutdown_start` relative to the new process's startup line.
- **Startup cohort record.** A log line carries the revision, flag value and
  quarantine end.

The guard leaves a residual window that the review must accept explicitly. Until
its SIGTERM, and within the G4 window, a flag-on predecessor keeps serving
retained bodies in at least these four cases:

- after a successor write whose bump fails or is skipped (`util/userRevision.js:69,86-88`);
- while a successor's bump is in flight (`:61-85`);
- after any write by a flag-off successor, which never bumps (`:55,102`), as in a
  deactivation or rollback deploy;
- after a successful successor bump, when the predecessor first observes the
  owner, or observes it again after eviction, and adopts a join or session-policy
  reuse that began before that write (the first-observation rule under Chart-cache
  guarantees).

Shutdown-start retirement ends each case at the signal. The residual runs from
the successor's first write to the predecessor's SIGTERM, and that write can come
before the successor is healthy: custom-build recovery restarts its background
reclassification lane before the server listens, and the lane promotes reclassified
games after its full-history scan with no health gate (`server.js:205-207,217`;
`services/customBuilds.js:852,856-873,2267`), while the opponent-MMR job starts at
boot with no health gate and stamps games at once (`server.js:289`;
`jobs/opponentMmrEnrichmentJob.js:136-138,446-447`). So the residual is at most the
successor's start-to-healthy time, which no assumed bound covers, plus the second
assumed bound. A successor that never becomes healthy triggers no signal, and its
boot writes can leave the predecessor stale, in the cases above, for the whole G4
window. The guard slice
must hold the successor's background writers until it is healthy, or its review
must accept this. A durable cohort registration in `jobLocks` is deferred, and is reconsidered only
if either provider bound cannot be qualified. A pub/sub broadcast is excluded as
new infrastructure (`apps/api/render.yaml:20-30`).

## Update rule

Update this ADR in the same pull request, with fresh citations, when a change:

- adds or removes a covered response kind or a writer of a covered input;
- adds a process-local cache that answers for durable state read by a covered
  kind or a device-credential path;
- adds, moves or reclassifies a device-credential writer or reader path;
- adds or removes an unguarded first-observation source, which the list under
  Chart-cache guarantees must then match: a caller outside `send(kind)` of a
  covered kind's method that runs through TrendsRequests, another caller of a
  TrendsRequests or session-policy key that a covered kind adopts, or a change to
  which requests bypass the guard (`middleware/userCache.js:109-111`);
- changes the fleet shape, the shutdown order, the logs a receipt relies on, or a
  time bound, size cap or constant cited here, such as the 1800 ms and 2100 ms
  constants, the 600-second cache TTL, the 30-second join age or the 60-second
  device-auth entry lifetime;
- changes the `UserRevision` invalidator wiring (`app.js:1004-1007,1011-1019`) or ADR 0071's
  activation and rollback prerequisites.

The inventory test fails when the source drifts from its own copy of the
credential actor table. It does not read this ADR, so this ADR's tables and
citations stay in step by review, like the chart-cache tables.

## Consequences

No runtime behavior changes. `USER_CACHE_ENABLED` stays off, the REST adapter
stays uninjected and faster-dashboards stays partial. The next cache-coverage
slice cites the admission checklist; probe suppression, the disable primitive,
the authorized repair primitive, the overlap guard and the cohort receipt consume
the definitions here. A contract
cannot prove the production cohort, provider retirement timing, clocks or
elections.
