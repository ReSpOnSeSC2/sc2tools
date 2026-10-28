# Device authentication reuse: writer preparation

## Prepared readiness and optional REST seam — local candidate

The isolated `codex/device-auth-rest-reuse` candidate starts at local merge
`2e4a6949`, combining preserved helper `c3d7a592` with passed main/Reader PR810
`b8ef1b94`. The helper branch remains unchanged. This candidate is not committed,
published, deployed or activated; local verification is recorded separately.

Production factory writers share bounded prepared-authority readiness. Startup
failure leaves original uncached REST/socket authentication usable. Credential
callbacks still await valid readiness and their original durable gate/drain.
Actual preparation/session work remains charged after timeout and drains on
stop; readiness binds the same incarnation before begin's CAS.

The existing hello distinguishes strict causal readiness, positive writer-only
standalone and unsupported/unknown state. There is no new flag or NODE_ENV
bypass. Standalone cannot construct a retained adapter; a missing replica
operationTime never selects compatibility. Schema, pending/denyAll and original
majority/journal writer behavior remain.

The public Pairings lookup shares its exact query/projection/touch body with a
private cache-only closure. Optional REST middleware consumes a ticket once at
its final synchronous boundary and uses a new independent original fallback.
The app leaves this adapter uninjected; sockets retain the original method.
No reader prepares authority, writes active mode or clears uncertainty.

The approved production observation covers only legacy retirement inference,
one own-principal quiet snapshot and a causal majority barrier. Authority was
absent: current df5 paused/unknown lifetimes and incarnation continuity remain
unqualified. Deploy a prepared cohort, retire every prior pre-readiness writer
(including later df5-derived releases), bind the same
incarnation and complete independent runtime/release/clock/election gates before
activation. See [ADR 0071](../adr/0071-device-credential-readiness.md).

Existing Help already explains confirmation can take a few seconds and remains
unchanged; this prerequisite adds no public control. Chart caching stays off
and the parent performance item remains partial. No native release is needed.

## 2026-10-28 delivered writer prerequisite — prior chronology

PR 807 merged as `df5cf875d588fafba5456695a1c3550fc42ba587` after its exact tested head and fresh-main tree checks. Actual Vercel Ready and Render Live source were observed at `2026-10-28T16:46:09.182Z`; primary-domain new Help and read-only Devices loading were verified. [Sanitized production receipt](validation/device-auth-coordination/production-df5cf875.json) preserves that scope without account/device rows, counts or private photos. No production credential mutation, credential metadata observer or activation was performed.

Writer preparation and the backup-health shutdown correction are deployed. Retained authentication remains off; the separate credential-writer/incarnation cutover is unqualified and dependent reuse is unwired. The game-statistics cutover cannot replace it. The pre-release sections below are retained historical candidate chronology, superseded by this delivery status without transferring their local tests into production proof.

## 2026-10-28 candidate — historical local verification

The write coordination stage is implemented for review. It does **not** add
retained REST authentication, lease grants, reader activation or an endpoint.
`findTokenByHash`, REST request metadata, device socket authentication, minute
touches and 30-second latest-agent metadata reuse keep their existing paths.
`USER_CACHE_ENABLED` stays off. The requested 60-second reuse and the broader
`faster-dashboards` item remain partial.

One dedicated record in the existing `jobLocks` collection stores a fixed
protocol/owner-hash namespace, incarnation, UUID generation, up to eight pending
credential operations and sticky `denyAll`. It has no top-level `expiresAt` or
`owner`, so generic job-lock TTL/release cannot remove it. A missing record is
conservatively recreated in **prepared** mode with unknown grant history; no
reader activation follows from boot or record creation. Every credential control
waits the full 2.1-second old-lease bound after a majority-acknowledged gate. This
latency is deliberate; prepared mode does not prove that old grants never existed.
Recreation can also lose unresolved scopes from the missing predecessor. Its
empty pending list is **not** settlement evidence. Any later reader activation
requires a new all-writers/unknown-work cutover receipt for that incarnation;
the finite reader drain alone does not settle arbitrary old credential promises.

Actual insertion, hash/ID revocation and full account erasure share the same
coordinator. Pairing acquires its user-data admission after coordination waits and
then checks ownership, expiry and one-shot consumption atomically with a fresh
timestamp; the acquired lease's final release stays inside shutdown-owned work.
A completion-metadata failure cannot reopen an issued code. Full
erasure retains its original cleanup and liveness-fence ordering inside the
credential lifetime; webhook and deletion retries share that path. Metadata-only
touch/heartbeat/label/event writes and history wipe/restore do not become
credential mutations. Restore still excludes device tokens.

Unknown or unacknowledged writes keep their durable scope pending. No TTL,
successful token read, restart or ordinary initialization clears uncertainty.
Missing owner scope or pending overflow establishes sticky `denyAll` before
dispatch instead of growing unbounded tombstones. Original uncached auth keeps
working; this is a retention gate, not an account lockout. Shutdown stops new
credential enrollment and drains actual admitted work before stopping its game
writer dependency and closing Mongo.

Two new suites cover real replica-set metadata writes, separate coordinators in
one process,
unknown acknowledgements, malformed namespace/state, bounded overflow, expiry
and ownership changes across pairing waits, actual revoke/erasure integration,
no auth caching, and shutdown lifetime. An earlier serial API run passes **227
tests in 15 files**, including all 42 new cases, with zero skips; all 88 Help
tests and whole API/web types also pass. After the final internal-helper and
validator style cleanup, **42 new tests in two files**, whole API types and
strict coordinator/pairing/test lint were rerun and pass with zero skips. The
explicit repository checks pass: seven public methods, 166 class lines, no
function over 60 lines and complexity at most 10. The earlier 227/88 results
remain separate historical evidence, not a claim that those full batches were
rerun after this final cleanup. Independent review reverses only the private
method/validator extraction and reconstructs the earlier tested helper exactly.
Existing server/GDPR warning counts remain 1/6 against the unchanged base, with
zero added rule occurrences. Earlier strict Help lint and web types retain
unchanged input paths. `git diff --check` passes. The new poll length warning was
resolved by extracting its existing insertion/unknown-ACK handling into a
private helper inside the same coordinated lifetime.

The final focused source/runtime packets are
`C:/SC2TOOLS/.cache/device-auth-coordination-20261028/final-source-ready-02.json`
and `runtime-verification-02.json` in the same folder. Their earlier unnumbered
versions remain historical. The source delta review is
`final-independent-review-02-dod-delta.json` in that folder (SHA256
`51f2221a9db773ce207b3f3adfd79bb0f1e8f9e1f25e49e1806b65be9a2d84d9`).

Local runs use the already-cached Mongo 7.0.14 binary, downloads disabled and
one serial database member at a time. Cleanup verifies no recorded owned
process, listener or pinned Mongo process remains. Failed sandbox starts, the
initial type/lint failures and Mongo library shutdown socket-reset warnings are
retained in `C:/SC2TOOLS/.cache/device-auth-coordination-20261028`. The warnings
occur in the library's shutdown command path before its process cleanup; actual
exit and listener cleanup were checked. No assertions were removed or skipped.
These are local same-process/coordinator tests, not a failover, independent
process, clock-bound or production acceptance claim. Full required CI,
exact merged revision/deployment and relevant live acceptance remain unverified.
No production delivery is claimed by this checkpoint.

The reviewed design is
`C:/SC2TOOLS/.cache/device-auth-mongo-lease-design-20261028.json`
(SHA256 `d7f9770a918f48672fc77856c35e666e8769ca8bb34f953da9e6837d3ca15ec2`),
with independent review
`C:/SC2TOOLS/.cache/device-auth-mongo-lease-independent-review-20261028.json`
(SHA256 `36f4b3a74cda02c51545df0fb6138875be328a9315ecb98029cba9f4bd611bde`).
The candidate deliberately supersedes its optional prepared-mode drain saving
with conservative unknown-history draining, as directed during source review.

Before any future retained-read release, deploy and verify **all** credential
writers on this protocol, settle old unregistered processes, then separately
review/activate demand-driven short authorization leases and final synchronous
cached admission checks. Initial all-writer cutover cannot be inferred from one
configured instance or a Ready deployment. Rollback to an unregistered writer
requires disabling grants durably and draining all old leases first. Manual
credential edits or raw database restores need the same explicit barrier; no
process-local cache can observe them automatically. No cached reuse, failover,
clock-bound or universal post-ACK authorization proof is claimed at this stage.

## CI and shutdown corrections — October 28

The first PR807 head, `df88f0ce29901276fe2f9fa1a8df1810b317bc3f`, passed
web, responsive and Vercel checks. Its API run found two replay-storage test
fixtures routing the new coordination collection to an incomplete fake. The
suite continued making progress until the total 15-minute job deadline; it
did not finish, and no successful full-API result is claimed for that head.

The fixtures now use the real Mongo coordination collection and the default
shared production coordinator. Only their test clock advances virtually.
All original R2 assertions remain, with additional uncertain/writing/completed
gate assertions. The focused 65 cases pass. The total CI job budget is now
25 minutes; serial execution, individual deadlines and assertions are unchanged.

Actual filtered production shutdown logs also exposed `tick.settled is not a
function` in the backup-health task. Its stop method now awaits the existing
single-flight check. Three regressions cover idle stop and held successful or
failed work with real job-ledger instrumentation. All 55 backup/job cases,
whole API types and strict owned lint pass; the original source reproduces
the error. This does not establish that every recent shutdown reached that
stage, or claim that best-effort diagnostic writes are a new drain contract.

Compact repair evidence is in `validation/device-auth-coordination/ci-repair/`.
Raw CI logs and failed local runs remain in the cache. No web runtime input,
budget, engine asset or credential read path changed in this correction.
Required checks on the new head and actual deployment remain pending.

## Combined adoption with delivered Unit Profile — local gates

The local merge `e0c47b9c4a07da30c2a9222ee6c8d0042000de12` includes accepted
Unit PR809 and the retired server-preview path. The actual combined API run
passes 176 cases in eight suites, including coordination/replay-storage, backup
and job ledger, retirement/routes and Unit readiness. Whole API types pass.
The command receipt retains a 47-file historical pin inventory; the raw Jest
report establishes the actual eight-suite set and counts. This is a distinct
run, not a repeat of the earlier 320-case affected batch.

Direct production Next build `QMJKSmPlv5oh8_4wduapJ` passes all 83 unchanged
route budgets. Prebuild/postbuild/postbrowser guards match 6,901 source inputs
and 40 canonical engine inputs / seven active assets / the strict four-game
sample. No generation, download or pruning ran. These full-source guards
precede the later two Unit delivery-document edits and new sanitized production
receipt. Independent rehash finds every other admitted source byte unchanged.
This new evidence/checkpoint adoption is an additional documentation-only delta;
it does not relabel the historical 6,901-file guard as a post-adoption check.

The identical actual-component Unit matrix reruns against the combined build
and passes eight cases, 40 full default Axe scans with zero violations or
exclusions, and 40 geometry specimens at 320/390/768/1280 in both themes.
Its 177 product inputs and fresh CSS/fonts are bound to the build. Auth, seed,
GET-only HTTP, account-write sinks and Next primitives are explicit adapters;
only keyboard Retry is exercised. This is local component QA, not a live
provider/account, actual routing, network timing or production phone proof.

The first browser attempt failed at the sandbox Chromium launch before product
test bodies. The host rerun uses the byte-identical spec and fresh outputs.
An initial postbrowser admission/CIM failure and later cleanup timezone metadata
error remain retained; explicit-UTC final checks exclude inspected unrelated
installed Chrome without stopping it and show no owned process/listener remains.
No assertion, skip, worker cap or budget changed to pass these checks.

The adopted Unit delivery docs separately record exact PR809 CI/tree equality,
Vercel Ready and Render Live at `f2138684`. Actual signed-in acceptance observed
the new loading state then a real 1,000-game Unit Profile question. That was
measured desktop 1905 by 889; the attempted phone override was ineffective and
reset. No answer/XP attempt, settings Save or personal upload was performed;
normal background account/network activity was not instrumented. No private
production image is copied. Unit delivery does not establish Auth delivery.

Compact combined receipts are in
[validation/device-auth-coordination/combined-unit](validation/device-auth-coordination/combined-unit/README.md).
Raw reports, 24 LOCAL captures, source snapshot and original failures remain in
cache. CI at `55cd362c` is historical only; exact new final-head required checks,
Auth deployment/live behavior and separately qualified credential-writer cutover
remain pending. Cached reuse and activation remain unimplemented.
The canonical count remains qualified at 123 completed / 74 remaining, unchanged.

## Historical prerequisite audit

The requested 60-second credential reuse remains unfinished. Existing minute
device touches and 30-second latest-agent metadata reuse are delivered and must
not be rebuilt. `findTokenByHash` still performs an authoritative lookup.

The source audit covered issue, revoke, revoke-by-ID, heartbeat/touch/label/event
markers, GDPR erasure/restore, unknown write outcomes and delayed credential
loads. Existing liveness retirement intentionally permits an older metadata DTO;
that contract cannot authorize a request with a revoked token.

Before adoption, establish serving-process and rolling-deployment coherence or
design an explicit cross-process revocation contract. One Render service page
showing Live does not prove only one process can serve throughout deployment.
Loads started before their owner is known need a global retirement fence; final
authorization admission must also reject a retired credential. REST and socket
handshakes currently share the lookup, so any narrower reuse boundary must be
explicit and preserve authoritative socket authentication.

No authentication cache, provider configuration or flag was changed by this
audit. Detailed local contract, 12 writer cases and 15 source pins are retained
in `C:/SC2TOOLS/.cache/device-auth-reuse-audit-20261027.json`. Future implementation
requires focused issue/revoke/GDPR/unknown-outcome/delayed-load tests and actual
deployment-lifecycle verification. The broader dashboard item remains partial.
