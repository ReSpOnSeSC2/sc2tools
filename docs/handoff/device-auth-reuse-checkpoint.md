# Device authentication reuse: writer preparation

## 2026-10-28 candidate — locally verified, not released

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
