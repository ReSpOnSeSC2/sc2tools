# Device auth: separate-process revocation regression (October 30 UTC)

The program remains active and incomplete. Faster-dashboards slice DA3 adds the
first separate-process test of the unwired device-auth REST reuse path. Until
now every revocation and lease test ran its reader and writer inside one Node
process, so the separate-process gate in
[ADR 0072](../adr/0072-serving-cohort-coherence.md#gates) was unmet
(`docs/handoff/device-auth-rest-reuse-helpers-checkpoint.md:89-91`). API paths
are relative to `apps/api/src/`.

The new test forks a reader process and a writer process. Each has its own Mongo
client and runs the real pairing, credential-writer, readiness and reuse code
against one replica-set member. The reader prepares a one-use ticket, then
blocks its own event loop for eight seconds, longer than the 1.8-second lease.
While it is blocked, the writer revokes the device, and the writer's
acknowledgement reaches the reader over IPC. When the reader resumes, the held
ticket, a second consume of it and an independent original lookup must all
return nothing.

Only tests change. No application source, flag, provider setting, migration or
infrastructure change is included: `app.js` still injects no adapter
(`app.js:350-356`) and `USER_CACHE_ENABLED` stays off. DA3 is stacked on C4
([PR #831](https://github.com/ReSpOnSeSC2/sc2tools/pull/831)) and merges after
it.

## What changed

- `apps/api/__tests__/deviceAuthSeparateProcess.mongo.test.js` (new). The parent
  starts a one-member MongoDB 7.0.14 replica set and forks both children with a
  minimal environment (`apps/api/__tests__/deviceAuthSeparateProcess.mongo.test.js:19-24`).
  It requires three distinct process ids and a causal readiness capability in
  each child (`:90-94`), activates the synthetic database's authority record as
  a test-only step (`:95-100`), and drives the sequence above (`:104-110`).
  Every child must spawn, exit and close with code 0 and no signal (`:66-67`).
- `apps/api/__tests__/helpers/deviceAuthProcessWorker.js` (new), the child. It
  loads the services under test (`apps/api/__tests__/helpers/deviceAuthProcessWorker.js:10-13`),
  records the read concern of every token read and the write concern of every
  authority write (`:104-107`), and blocks the event loop with `Atomics.wait`
  (`:43`). Admission after the acknowledgement is synchronous, with no renewal,
  fresh prepare or fallback before the consume (`:48-52`).

## What it shows

- Across processes, a grant does not outlive its lease in wall-clock time. The
  reader's loop was blocked for at least 8000 ms, longer than the 1800 ms lease,
  and its cached generation did not change
  (`apps/api/__tests__/deviceAuthSeparateProcess.mongo.test.js:113-115`).
- A revocation acknowledged by another process stops the held ticket, a second
  consume and the original lookup (`:116`).
- The prepare read is a majority read with a causal floor, and the original
  lookup after the revocation is a plain read (`:117-120`).
- The authority record holds no pending entries afterwards (`:121`).

## What it does not show

- Election or primary change, host suspension, clock rate, more than one host,
  or a serving-process cutover. The test uses one member on one host, and those
  gates stay unmet under their own ADR 0072 rows.
- Activation. The authority record is activated only in a synthetic test
  database. Serving stays uninjected, and this test is never a rollout step.
- Any latency, load or savings figure.

## Verification

Local checks ran at `6df0f447`, DA3 with C4 merged in. The receipt is
`docs/handoff/validation/device-auth-separate-process/local-verification.json`.

- **API.** Whole-API types pass. Configured lint reports 758 warnings and 0
  errors, the same as C4, and neither new file has a lint message.
- **Suites.** The fourteen device-auth suites pass 174 of 174 cases in band, on
  cached MongoDB 7.0.14 with downloads disabled. Both children exited with code
  0, and no MongoDB process was left over. Teardown logs one `ECONNRESET`
  warning as the in-memory replica set stops, as the existing reuse suite does.
- **Mutation.** 3 of 3 deliberate regressions are killed: a consume that skips
  the eligibility check, a grant that never expires, and a revoke that writes
  nothing.

## Limitations

- One test, one ordering. The reader blocks after its prepare and before its
  consume. Other interleavings stay covered by the single-process suites.
- `Atomics.wait` blocks a real OS thread, but it does not suspend the host or
  change the clock rate.
- The children use a test pool (two connections, five-second socket timeout),
  not the serving pool settings.

## Remaining dashboard work

DA4 (the durable disable primitive), G1 (the chart-cache overlap guard), C5
(opponent-collection writers) and R1 (the activation review) remain. ADR 0072's
election, clock, cohort-qualification, repair and activation-CAS gates are
still unmet.
