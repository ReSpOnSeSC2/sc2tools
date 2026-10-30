# ADR 0072: Serving-cohort coherence for retained chart and credential state

Status: Accepted contract, October 30, 2026. Documentation plus one source-inventory
test. It changes no runtime behavior, flag, provider or infrastructure, produces
no receipt and activates nothing. `USER_CACHE_ENABLED` stays off and
faster-dashboards remains partial.

Source paths are relative to `apps/api/src/` unless they start with `apps/` or
`docs/`. Line numbers are those of the commit that adds this ADR; its
application source equals `27b9aeb0`.

## Context

Two retained-state features are built but inactive: the default-off per-user
chart cache, which covers fifteen response kinds in source, and the uninjected
retained device-auth REST adapter. Both keep their state in one process. The
roadmap allows wider cache coverage only after "complete dependency/revocation
and shared-fleet audits" (`docs/handoff/roadmap-progress-2026-10-28.json:1963`)
and requires "an explicit serving-process/rolling-overlap revocation contract"
for device auth (`:1966`). ADR 0071 still defers the real clock, election and
cross-process assumptions (`docs/adr/0071-device-credential-readiness.md:56-57`),
and the engineering explanation requires fleet and out-of-band writer coherence
before the flag is enabled (`docs/engineeringexplanation.md:399-403`).

This ADR is the single normative home for that contract. ADR 0071 points here
and does not repeat it. It records what holds today, what does not and what a
later slice must prove. It is never cutover, activation or savings evidence.

## Fleet model

The API is one Render web service pinned to one instance (`apps/api/render.yaml:31`)
with `autoDeploy: true` and a `/v1/health` health check (`:18-19`). The pin
exists because Socket.io, LiveGameBroker and the rate limiter keep their state in
one process; scaling out first needs a shared store (`:20-30`). The blueprint
sets no shutdown delay. The live instance count, autoscaling, session affinity,
shutdown delay and flag value are dashboard settings, so they are verified by the
operator, not by the repository.

One instance is not one process. Every deploy starts the new process while the
old one still serves; `jobs/reviewDigestJob.js:12-17` already treats that brief
two-instance overlap as a real case, and a Live service page does not prove that
only one process serves (`docs/handoff/device-auth-reuse-checkpoint.md:281-283`).
A restart and a flag change also start a new process: `USER_CACHE_ENABLED` is read
once at boot (`config/loader.js:151`) into that process's own `UserRevision` and
`UserCache` (`app.js:394-396`). Every deploy, restart and flag change is therefore
treated as an overlap window, and none is qualified today. The health check proves
only a Mongo ping and write (`routes/health.js:60-79`), not the serving cohort.

On SIGTERM the server first retires the uninjected REST credential reuse, before
any await (`server.js:419-421`). The listener keeps accepting requests, including
retained cache hits, while three stops are awaited (`:424-426`). HTTP then closes
with an 8-second grace (`:433-448`), and the remaining stops run one after another
(`:450-486`). There is no overall deadline and no error handling: a stop that
rejects skips the remaining drains and the exit (`:413-414,417-487`), and the
process then lives until the platform kills it. Nothing in shutdown touches
`UserCache`.

The only retirement bound the program has adopted is the conservative published
300-second shutdown bound in ADR 0070 (`docs/adr/0070-maintained-account-statistics.md:80-86`).
This ADR adopts the same figure for both consumers below as a **qualified
provider assumption**, not proof: the repository does not enforce it, and a
receipt must observe it rather than assume it.

A multi-instance service, autoscaling and session affinity are unqualified. The
blueprint configures none of them (`apps/api/render.yaml:31-36`), and the
operator advisories report a configured multi-instance or autoscaled service as
not ready (`services/infrastructureAdvisories.js:338-349`). That advisory reads
the configured count and cannot see a deploy overlap. Any such change voids this
contract until it is revised.

## What crosses a process boundary

Each mechanism below is one of three classes:

- **Durable fencing** is a durable row checked with majority or transactional
  semantics. Only this class may authorize.
- **Durable advisory** is a durable value that each process re-reads. It may
  only invalidate.
- **Process-local** state lives in one process's memory. It may only deny or
  retire inside that process, and no other process sees it.

| State | Source | Class | Cross-process bound |
| --- | --- | --- | --- |
| `UserRevision` tokens, process epoch, owners, dirty and poisoned marks | `util/userRevision.js:11-21` | Process-local | None; peers never see them |
| `users.dataRev` | `util/userRevision.js:61-88,109-139` | Durable advisory | Re-read by every guarded request; never bumped by a flag-off process (`:55,102`) |
| `UserCache` entries and ETag salt | `middleware/userCache.js:10-12,19-33` | Process-local | 600-second TTL (`:11`) |
| TrendsRequests in-flight joins | `services/trendsRequests.js:4-5,21-28,76-84` | Process-local | 30 s; the join key carries no revision (`:79`) |
| `cached()` completed memo (random summary only, not covered) | `services/trendsRequests.js:42-67` | Process-local | 60 s |
| Momentum session-policy reuse gate | `services/sessionResolutionGate.js:14` | Process-local | 15 s |
| MMR curve memo and snapshot epoch | `services/mmrExpectation.js:10,84-89`; `services/strengthCurveSnapshots.js:13-27` | Process-local | 60 s; dependent entries expire with their proof (`middleware/userCache.js:268-270`) |
| Device touch dedupe and 30-second latestAgent reuse | `services/deviceLiveness.js:75-91,101-118` | Process-local | 30 s; the minute touch filter itself is durable (`services/deviceAuthTokenRead.js:37-44`) |
| Overlay-token resolve cache | `services/overlayTokens.js:60-61,88` | Process-local | 10 s; a revoke evicts only the local entry |
| `DeviceAuthReuse` and `DeviceAuthLease` grants (uninjected) | `services/deviceAuthLease.js:8,48-77`; `services/deviceAuthReuse.js:10-11,139-141` | Process-local, derived from durable fencing | 1.8-second grant; 60-second entries need the current generation |
| Credential authority record in `jobLocks` | `services/deviceCredentialWrites.js:7,12,90-133`; `services/deviceCredentialPreparation.js:38-45` | Durable fencing | Majority writes; 2.1-second writer drain |
| `gameStatsMutationEpoch` and `_gdprMutation` | `services/gameStatsWrites.js:89-93,147-154`; `services/gameStatsMaintenance.js:88-97,103-106` | Durable fencing | Checked inside majority snapshot transactions |
| GDPR repair liveness handle | `services/gdprRepairLiveness.js:15-19,80-97` | Process-local, deny-only | Cannot see lease expiry or loss in another process |
| User-data write fence lease | `middleware/userDataWriteFence.js:4,13-31,41-58` | Durable fencing | Admitted requests keep baseline semantics; never touches `dataRev` |
| Generic job-lock leases | `util/jobLock.js:55-94` | Durable fencing | TTL on `expiresAt` |
| Socket.io rooms, LiveGameBroker and rate-limit stores | `server.js:89-95`; `services/liveGameBroker.js:22-27,96-140`; `middleware/boundedRateLimitStore.js:12-14` | Process-local | None; covered only by the one-instance pin |

No invalidation broadcast and no durable record of serving processes exist.
Retained keys also contain process-local parts, the process epoch and token ids
(`middleware/userCache.js:257`), so retention must stay per process.

## Chart-cache guarantees

| | Guarantee | Today | Evidence |
| --- | --- | --- | --- |
| G1 | Every writer of a covered input invalidates retained bodies | Met only inside one flag-on process running the current writer set. Unmet for flag-off processes, older writer sets during an overlap, out-of-band migrations, manual edits and raw restores | In-process writers call `gameWrite` (`util/userRevision.js:163`; `docs/engineeringexplanation.md:408-412`); flag-off processes skip revision work (`util/userRevision.js:55,102`); `db/migrations/2026-09-30-rename-8-pool-builds.js:50,115-119` rewrites build and strategy labels with a plain `updateMany` |
| G2 | Revision uncertainty is visible across the fleet | Unmet | A failed, unknown or skipped bump marks only the local owner dirty (`util/userRevision.js:69,86-88`) |
| G3 | In-flight writes are visible across processes | Unmet | The bump runs after the semantic write and outside its transaction (`util/userRevision.js:61-85`); until a peer reads it, the peer can serve or 304 the prior body |
| G4 | Staleness has a time bound | Met per process | Entries expire after 600 s (`middleware/userCache.js:11,123`), and curve-dependent entries with their proof (`:268-270`). This is the only bound on the G1-G3 gaps |
| G5 | A validator never matches stale state from another process | Met for opaque tags only | Tags use a per-process salt and epoch (`middleware/userCache.js:31,219,257`; `util/userRevision.js:15`), so a peer's tag gets a full 200. `If-None-Match: *` matches any retained entry (`middleware/userCache.js:299`) |
| G6 | Deleted or GDPR-locked owners are never served | Met | Each guarded request re-reads the durable rows (`util/userRevision.js:119-125`) |

A process that sees an owner for the first time adopts the stored `dataRev`
without retiring anything (`util/userRevision.js:126-131`), so it also keeps the
owner's in-flight TrendsRequests joins. Unguarded callers can start those joins:
HEAD requests bypass the guard (`middleware/userCache.js:109-111`), and coaching
calls the MMR progression outside it (`routes/coaching.js:570-576`). A
first-observation request can therefore adopt a join up to 30 seconds old that
began before another process's write, then retain it for up to 600 seconds. A
later observation of a higher `dataRev` retires locally and answers that request
with a 503 and `Retry-After: 1` (`middleware/userCache.js:118-120,156-158`). New
kinds inherit this and every row above.

## Source-coverage admission checklist

A response kind may join the allowlist (`middleware/userCache.js:7-9`) while the
flag stays off only when a reviewer can tick every line with file:line evidence
at the pull request's base:

1. **Owner games only.** Every database read in the computation is on `games`
   and starts with `gamesMatchStage(userId, filters)` (`util/parseQuery.js:240-247`).
   There is no `$lookup`, `$unionWith` or other collection.
2. **Fenced writers.** Every field it reads, filter fields included, is written
   only inside `gameWrite` or `UserRevision.run` (`util/userRevision.js:98-106,163`)
   or is already read by a covered kind. Out-of-band writers stay G1 activation gates.
3. **No unretired inner memo.** An inner memo is allowed only if the
   `UserRevision` invalidator retires it (`app.js:1011-1019`). A time-based
   completed-result memo, such as the 60-second `cached()` used by random summary,
   disqualifies the kind.
4. **No clock.** No `Date.now`, `$$NOW` or relative time window in the computation.
5. **Other collections only before admission.** A route-level read of another
   collection is allowed only when its result is part of the key and checked by
   a publish guard, as momentum's session policy is (`routes/aggregations.js:224-235`).
6. **No unproved global input.** A global input needs a captured proof that drives
   both the key and the calculation, as the four strength routes do
   (`services/strengthCurveSnapshots.js:43-47`; `middleware/userCache.js:268-270`).
7. **Complete key.** Every request input is parsed before admission and passed as
   filters or options.
8. **Size.** Typical bodies fit the 512 KiB entry cap (`middleware/userCache.js:10`),
   and the pull request says whether the size is structurally bounded. Larger
   bodies go out as an uncached 200 (`:211-217`).
9. **Single path.** One service construction, one route call site and one web caller.
10. **Wiring.** The route uses `send(kind)`, the kind is in `ALLOWED_ROUTES`, and
    the off path stays byte-identical (`routes/aggregations.js:26-28`;
    `middleware/userCache.js:109-111`). The web list appends the path without
    moving existing positions, and holds at most 32
    (`apps/web/lib/conditionalApiScope.tsx:5-9`).
11. **Fleet note.** The pull request states that the kind inherits G1-G6 and the
    first-observation rule unchanged.

Passing this checklist is the shared-fleet audit that the roadmap requires before
coverage grows beyond fifteen kinds. It qualifies source coverage while the flag
stays off. It is not activation evidence.

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
(`services/userBackups.js:15`). The 30-second latestAgent reuse reads metadata and
cannot extend credential reuse (`services/deviceAuthReuse.js:127-136`). Metadata
writers never write a field that authentication reads.
`apps/api/__tests__/deviceCredentialWriterInventory.test.js` enforces this table:
a new reference to the collection, a new writer or a writer moved out of the
coordinator fails it.

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
against current source. Run-together tokens are the file's own bytes. The
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

Two implementation choices differ from the design text and are more conservative.
"Prepared mode grants no retained lease" does not mean a prepared writer skips
its drain: every credential gate drains in full (`services/deviceCredentialWrites.js:103-105`),
as directed in source review (`docs/handoff/device-auth-reuse-checkpoint.md:180-181`).
A missing authority record is recreated in prepared mode
(`services/deviceCredentialPreparation.js:38-45`), and an empty pending list in a
recreated record is not settlement evidence (`docs/handoff/device-auth-reuse-checkpoint.md:107-115`).

The constants in source match the design's examples: an 1800 ms reader grant
(`services/deviceAuthLease.js:8`) and a 2100 ms writer drain
(`services/deviceCredentialWrites.js:12`). The inequality is a proposed bound,
not a measurement, and the suspended-host-clock limitation stands. No immunity to
clock failure is claimed.

### Scope

Coherence holds only among protocol-v1 coordinated writers at or after
`b8608d90` (PR813). They obtain acknowledged prepared authority and validate the
incarnation before dispatching credential work
(`docs/adr/0071-device-credential-readiness.md:16-21`). Writers from `df5cf875`
(PR807), and the releases that shipped that writer unchanged until PR813, are
pre-readiness actors: they gate and drain but never validate an incarnation, and
they must be retired before any activation (`:51-52`). Readiness adopts whatever
valid record exists, including one a pre-readiness writer recreated
(`services/deviceCredentialPreparation.js:62-68`), so a cutover rests on retiring
old actors, not on where an incarnation came from.

While retention could be active, the following are forbidden unless a durable
disable and a full old-grant drain run first, followed by a fresh-incarnation
cutover: deploying or rolling back to a commit before `b8608d90`, manual edits of
device tokens or the authority record, and raw database restores. No durable
disable exists yet, so retention must not be activated before one ships.

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
| Every credential writer coordinated on protocol v1 | Met in source since `b8608d90`; enforced by the inventory test |
| Prepared startup observed | Met for one attempt only (`docs/adr/0071-device-credential-readiness.md:5-9`) |
| Serving cohort qualified, pre-readiness actors retired, same incarnation bound | Unmet (`docs/adr/0071-device-credential-readiness.md:51-55`) |
| Clock rate and suspension behavior verified | Unmet; the constants are proposed |
| Primary change and election behavior verified | Unmet (`docs/handoff/device-auth-rest-reuse-helpers-checkpoint.md:89-91`) |
| Separate-process evidence | Unmet |
| Durable disable and rollback primitive | Unmet |
| Failed-probe suppression | Unmet: an injected adapter would re-probe on the next demand (`services/deviceAuthLease.js:47-61`) |
| Reviewed activation CAS | Unmet |

## Out-of-band writers

While `USER_CACHE_ENABLED` is on in any serving process, or retained device auth
could be active, out-of-band writers are forbidden unless a named barrier runs
first. Out-of-band means anything outside the inventoried in-process writers:
migrations such as `db/migrations/2026-09-30-rename-8-pool-builds.js`, scripts
under `apps/api/scripts`, manual database edits and raw restores.

- **Chart cache.** Deploy with the flag off and let the old process retire under
  the qualified bound before the write. Retained bodies live only in memory, so
  that deploy discards them. Turn the flag back on only with a fresh receipt.
- **Device credentials.** Durably disable retention and complete the full drain
  before the write, then cut over to a fresh incarnation. Until a disable
  primitive exists, the only compliant state is that retention is not active.

## Activation receipts

Neither `USER_CACHE_ENABLED=true` nor injecting `deviceTokenReuse` may rely on
this ADR. Each needs a fresh read-only receipt, taken for a scheduled activation
review. This slice produces none.

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
| Predecessor retirement: its `shutdown_start`, both drained lines and `shutdown_complete`, observed at least 300 s after `shutdown_start` | Both | Logs, plus an owner observation |
| One cohort: no deploy, restart, flag change or instance change since that retirement | Both | Owner-run read of the deploy and event history |
| Writer set: the serving revision contains every inventoried writer | Both | Repository |
| Out-of-band freeze: no migration, script, manual edit or restore ran or is scheduled | Both | Owner attestation |
| Configured flag value and the admin tile reading | Chart cache | Owner-run dashboard read and the tile |
| Overlap guard deployed, or the TTL-bounded window accepted in the review | Chart cache | Repository and review |
| Authority record: protocol, namespace, incarnation, generation, mode, pending and `denyAll` at a causal majority read | Device auth | Owner-run read |
| Readiness digest equals the read record's incarnation digest | Device auth | Log and read |
| Pre-readiness retirement: the last process older than `b8608d90` has exited | Device auth | Deploy history and that process's shutdown lines |
| Disable primitive and failed-probe suppression shipped | Device auth | Repository |

A receipt describes one serving cohort. It decays at the next deploy, restart,
flag change, instance-count change or out-of-band write, and when a predecessor
shutdown lacks either drained line. Activation is itself a deploy, so its own
overlap is covered only by the guard below or by accepting the TTL-bounded window
explicitly in the review.

## Follow-on guard

Decided for the chart cache: the overlap guard slice uses three parts.
Shutdown-start retirement means a process stops serving and storing retained
bodies when SIGTERM arrives. A post-listen retention quarantine means a new
process stores nothing until every older process can have exited under the
qualified bound. A startup cohort record in the logs carries the revision, flag
value and quarantine end. A process cannot observe when the platform signals its
predecessor, so that slice must derive the quarantine start conservatively and
justify any margin. It needs no new infrastructure and stays default-off.

A durable cohort registration in `jobLocks` is deferred and is reconsidered only
if the provider bound cannot be qualified. A pub/sub broadcast is excluded as new
infrastructure (`apps/api/render.yaml:20-30`).

## Update rule

Update this ADR in the same pull request, with fresh citations, when a change:

- adds or removes a covered response kind or a writer of a covered input;
- adds a process-local cache that answers for durable state;
- adds, moves or reclassifies a device-credential writer or reader path;
- changes the fleet shape, the shutdown order, the logs a receipt relies on, or
  the 1800 ms or 2100 ms constants.

The inventory test fails when the credential actor table drifts. The chart-cache
tables have no such guard yet and rely on review.

## Consequences

No runtime behavior changes. `USER_CACHE_ENABLED` stays off, the REST adapter
stays uninjected and faster-dashboards stays partial. The next cache-coverage
slice cites the admission checklist; probe suppression, the disable primitive,
the overlap guard and the cohort receipt consume the definitions here. A contract
cannot prove the production cohort, provider retirement timing, clocks or
elections.
