# Device auth: failed-probe hold-off (October 30 UTC)

The program remains active and incomplete. Faster-dashboards slice DA2 bounds
the grant probes of the unwired device-auth lease. Until now, a probe that ended
without a grant was simply cleared, so the next request started another probe.
Once the REST adapter is injected, a prepared, missing or unreachable authority
record would have cost one majority/journal `findAndModify` per coalesced device
request (a nonce write only when a row matches). Now a probe that settles
without a usable grant holds off new probes for one lease, 1.8 seconds from the
moment it settles, and every later failed probe re-arms it. During the hold-off
`acquire()` returns no grant at once, with no database call and no wait, and the
caller uses the original lookup. API paths are relative to `apps/api/src/`.

This is the failed-probe suppression gate in
[ADR 0072](../adr/0072-serving-cohort-coherence.md#gates), and this slice updates
that row. Nothing is wired: `app.js` still injects no adapter
(`app.js:350-356`), `USER_CACHE_ENABLED` stays off, and no provider setting,
flag, activation, migration or infrastructure change is included. No latency,
load or savings figure is claimed.

DA2 is stacked on C1
([PR #825](https://github.com/ReSpOnSeSC2/sc2tools/pull/825)) and F1
([PR #824](https://github.com/ReSpOnSeSC2/sc2tools/pull/824)), and merges after
both.

## What changed

- `services/deviceAuthLease.js:20` adds `probeAfter`, a time on the lease's
  elapsed clock.
- `:50` returns `null` without starting a probe while none is in flight and the
  clock is before `probeAfter`.
- `:94-96` sets `probeAfter` to the settlement time plus `DEVICE_AUTH_LEASE_MS`
  whenever a settlement leaves no usable grant: an acknowledged no-match or
  invalid row, an unknown acknowledgement, an error, or a result that arrives
  after its caller's deadline. A probe retired by its caller's deadline is still
  in flight, so it starts the hold-off only when it actually settles.

## What it is not

- **Not a token negative cache.** The hold-off keeps only a time: no token,
  owner hash, row or authority value. During the hold-off the reuse cache gets
  no grant and returns `null` without a token read
  (`services/deviceAuthReuse.js:226-227`), and the REST middleware then runs the
  original lookup (`middleware/auth.js:76-82`). The reuse helpers' "No negative
  cache" (`docs/handoff/device-auth-rest-reuse-helpers-checkpoint.md:65-67`)
  excludes negative token results, which their entries never hold; the hold-off
  retains none, `apps/api/__tests__/deviceAuthReuse.test.js:59-67` passes
  unchanged, and a held-off `null` still gets the separately issued original
  lookup that the same paragraph requires.
- **No new authority.** Grants still come only from a probe's majority write. A
  valid grant, including a `denyAll` grant, starts no hold-off and is kept for
  its lease as before.
- **No change to the grant protocol.** One probe in flight, 16 waiters, the
  deadline from the pre-dispatch start, `stopAndDrain` and clock poisoning are
  unchanged.

The reviewed design, pinned by hash in ADR 0072, says at line 49 that "A retry is
a new demand probe with a new start/deadline and must satisfy current
authority". Every probe that runs still is one; the hold-off only delays a retry
by at most one lease after a failure. ADR 0072 records this reading next to its
one design departure: the hold-off is not a departure.

With continuous demand and no usable grant, a process now starts at most one
probe per probe duration plus 1.8 seconds; before, it started the next one as
soon as the previous one settled. With a valid grant nothing changes: one probe
per 1.8-second lease.

## Tests

- `apps/api/__tests__/deviceAuthLease.test.js`:
  - for a prepared row, a missing row, an error and an unknown acknowledgement,
    twenty acquires and a reuse `prepare` inside the hold-off make no database
    call and no token read; exactly one probe follows when the hold-off ends
    (`apps/api/__tests__/deviceAuthLease.test.js:80-98`);
  - a probe retired by its caller's deadline starts the hold-off at its actual
    settlement; its refused in-flight caller and the settlement happen at
    different times, so only settlement timing passes (`apps/api/__tests__/deviceAuthLease.test.js:100-113`);
  - a persistently prepared or missing authority re-arms the hold-off after every
    failed probe: nothing is sent inside the second window, and exactly one probe
    follows it (`apps/api/__tests__/deviceAuthLease.test.js:115-131`);
  - a `denyAll` grant whose probe settles after it started is kept for its lease
    and starts no hold-off (`apps/api/__tests__/deviceAuthLease.test.js:133-144`);
  - the unknown-acknowledgement test moves the clock past the hold-off before its
    second probe (`apps/api/__tests__/deviceAuthLease.test.js:70-78`), and real timers are restored after every test (`apps/api/__tests__/deviceAuthLease.test.js:7`).
- `apps/api/__tests__/deviceAuthReuse.mongo.test.js`: the missing, prepared and
  unknown-acknowledgement test moves its virtual clock past each hold-off and
  counts real grant probes, so none of its steps can pass without probing. One
  tick before the second window ends, an acquire against the prepared row sends
  nothing (`apps/api/__tests__/deviceAuthReuse.mongo.test.js:98-99`).
- `apps/api/__tests__/deviceRestAuthReadiness.mongo.test.js`: the shared
  adapter's lease uses the real clock, so the test waits one lease and checks
  that a second real probe reaches the prepared row.
- The active-authority tests (`apps/api/__tests__/deviceAuthLease.test.js:9-25,27-37`)
  pass without edits.

## Verification

Local checks ran at `1dde734b`, the merge of C1's head into this branch, whose
lease and lease tests equal `2a92b201`
([receipt](validation/device-auth-probe-hold-off/local-verification.json)):

- **API.** Whole-API types pass. Configured lint has 757 warnings and 0 errors.
  The lease passes strict lint (complexity 10, 60 lines per function), and the
  lease and the three changed tests add no configured or strict message. The
  `DeviceAuthLease` class is 123 lines.
- **Suites.** All sixteen device-auth suites pass 231 of 231 cases, in band on
  cached MongoDB 7.0.14 with downloads disabled, and no MongoDB process was left
  over.
- **Mutation.** Seven deliberate regressions each make the intended tests fail:
  the hold-off check removed, a hold-off ending at the probe's deadline, a
  hold-off after a valid grant, an inclusive end, a late valid result that does
  not hold off, a hold-off armed only once, and a hold-off armed by refused
  callers instead of by the settlement. The unit suite proves the hold-off
  itself; the real-Mongo suites prove that each step still probes, plus the
  in-window check against a prepared row.
- **Review.** An independent read-only review with a skeptic per finding found
  no code defect and no blocking issue. Its findings on test coverage and on the
  ADR and checkpoint wording are addressed here.

## Limitations

- The adapter is not injected, so production behaviour is unchanged and no
  probe rate is measured.
- Callers that coalesce on a slow in-flight probe can still wait up to one
  lease. That latency choice belongs to the later wiring slice.
- ADR 0071's "prepared metadata adds no grant probes to ordinary authentication"
  (`docs/adr/0071-device-credential-readiness.md:47-48`) holds only because the
  adapter is uninjected. DA2 bounds these probes but does not remove them: once
  wired, a process facing a prepared, missing or unreachable record starts at
  most one probe per probe duration plus 1.8 seconds under continuous demand. So
  DA2 does not meet the scoping wish that ADR 0071:47-48 stay true after wiring.
  Before ADR 0072's activation step 2, the wiring slice must either accept this
  bounded rate in ADR 0071 and ADR 0072's Gates row, or send no probes while the
  record is prepared.

## Remaining dashboard work

The parent `faster-dashboards` item stays partial. The scoping order continues
with C2 (net MMR by matchup), C3 (random summary's memo), C4 (the matchup time
series' curve proof), DA3, DA4, G1, C5 and R1. `analysis-corpus-local-cache`
follows the dashboard work, and the final `docs/SETUP_GUIDE.md` is still
required when the whole program is delivered.
