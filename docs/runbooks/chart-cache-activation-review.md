# Chart cache activation review (R1)

Status: prepared, not scheduled. Nothing in this runbook has been run.
`USER_CACHE_ENABLED` stays off until the owner completes this review and
decides to activate. This is the faster-dashboards slice R1: it prepares the
review only, makes no production read, and changes no flag, provider setting or
infrastructure. Source paths are relative to `apps/api/src/` unless they start
with `apps/` or `docs/`.

[ADR 0072](../adr/0072-serving-cohort-coherence.md) is the contract. This
runbook turns its chart-cache rows into a review the owner can complete in one
sitting. Where the two differ, the ADR wins, and this runbook must be corrected
in the same pull request.

Device-auth retention is a separate activation and is out of scope here. Its
gates for repair, election, clock rate, cohort qualification and the reviewed
activation CAS are unmet (ADR 0072, Gates).

## What activation means

Activation is a flag-on deploy of the API service. The flag is read once at boot
(`config/loader.js:151`), and only the literal string `true` enables it. With
the flag on:

- the 23 covered response kinds are retained per owner in process memory, for
  at most 600 s after each store;
- a browser revalidates a retained response with `If-None-Match` and gets a 304
  when nothing changed;
- every covered write retires the owner's retained bodies through
  `UserRevision`;
- nothing is persisted, so a deploy or restart discards everything.

The covered paths are listed in `docs/engineeringexplanation.md` under the
allowlist paragraph.

The service is pinned to one instance with automatic deploys
(`apps/api/render.yaml:19,31`), so every merge to `main` is a deploy, and every
deploy is a rolling overlap between two processes.

## Decisions the owner must accept in writing

Activation depends on accepting each item below. Record the decision, the date
and the person in the receipt.

1. **G1-G3 stay unmet.** Cross-process invalidation is not guaranteed. During
   any overlap a predecessor can serve a body that is stale by the successor's
   writes. The bound is G4: 600 s after the store, plus the computation and any
   adopted join age.
2. **Unheld background writers.** Custom-build reclassification recovery and
   the opponent-MMR job start at boot with no health gate (`server.js:205-207,289`).
   Their writes can leave a flag-on predecessor stale until its SIGTERM, or for
   the whole G4 window if the successor never becomes healthy.
3. **End-of-quarantine session effect.** 420 s after each boot, the first chart
   request runs a full local retirement. A session-policy request in flight at
   that instant can fail once with 409 `session_policy_changed`, or with a 500
   where `SESSION_RESOLUTION_STALE` is not caught
   (`docs/handoff/dashboard-cache-overlap-guard-checkpoint.md`).
4. **Quarantine after every boot.** For the first 420 s after a deploy or
   restart, nothing is retained, so every response is an ordinary 200.
5. **Daily trust floor.** With the flag on, the opponent-MMR trust floor moves
   once per UTC day. A game within one day of the 365-day horizon can count as
   trusted until the next UTC midnight.
6. **Out-of-band writes need a barrier.** While the flag is on, migrations,
   scripts, manual edits and raw restores are forbidden unless the barrier runs
   first: deploy with the flag off, let the old process retire, write, then
   turn the flag back on with a fresh receipt (ADR 0072, Out-of-band writers).

## Receipt

Take the receipt during the scheduled review, for the flag-off cohort that will
be flipped. Every row is an owner-run read. A receipt decays at the next deploy,
restart, flag change, fleet-shape change or out-of-band write, and a decayed
receipt supports nothing.

| Row (ADR 0072, Activation receipts) | How to read it | Value | Read at (UTC) |
| --- | --- | --- | --- |
| Serving revision and process identity | Startup log lines and the deploy record | | |
| Fleet shape: one configured instance, autoscaling and session affinity off, the configured shutdown delay | Render dashboard; the admin infrastructure overview can corroborate count and autoscaling | | |
| Predecessor retirement: `shutdown_start`, both drained lines and `shutdown_complete`, read at least 300 s after `shutdown_start` | Logs | | |
| Earlier processes: every other process in the retained logs shows `shutdown_complete`, or is named | Logs and the event history | | |
| One cohort: no deploy, restart, flag change or fleet-shape change since the predecessor retired | Deploy and event history | | |
| Out-of-band freeze: none running, none scheduled, none since the predecessor retired | Owner attestation | | |
| Writer set: the review re-derives the writers of every covered input at the serving revision. `WRITER_SET_VERSION` reads `2026-10-30.2` (`middleware/userCacheGuard.js:13-15`), and `apps/api/__tests__/opponentsWriterFence.test.js` passes there | Repository review at the serving revision | | |
| Configured flag value and the admin tile reading (Off, Not reported or Enabled) | Dashboard read and the admin tile | | |
| Overlap guard deployed, with decisions 1-4 accepted | Repository and this review | | |

## Procedure

Run it only after every receipt row is filled and every decision is accepted.

1. Confirm `main` contains the merged stack (C1-C5, DA2-DA4 and G1) and is
   deployed with the flag off. Confirm health at `/v1/health`.
2. Take the receipt above for that cohort.
3. Set `USER_CACHE_ENABLED=true` on the API service and deploy. The new process
   logs `chart_cache_cohort_start` at listen, with the revision, the flag, the
   writer-set version and the quarantine end.
4. Observe the predecessor's `shutdown_start` within 120 s of that line. Later
   than 120 s breaks the quarantine's assumption, so roll back.
5. After the quarantine ends, the admin tile reads Enabled, and covered
   responses carry an ETag with `private, no-cache`.
6. While the flag stays on, every later deploy is another overlap, covered only
   by the guard with the accepted residual. Merges keep deploying automatically.

## Rollback

Set `USER_CACHE_ENABLED=false` and deploy. The flag-off process never retains,
and the flag-on predecessor stops serving retained bodies at its SIGTERM.
Flag-off processes never bump `dataRev`, so a write during that overlap can
leave the predecessor stale until then (decision 1). There is no persistent
state or data migration to undo.

## What this review cannot establish

- Latency, request-reduction or cost savings: none is claimed. After
  activation, the admin tile's hit, miss and bypass counters are the read-only
  measurement.
- Fleet behavior beyond one instance: scaling out needs a new contract.
- Device-auth activation: separate gates, unmet.
