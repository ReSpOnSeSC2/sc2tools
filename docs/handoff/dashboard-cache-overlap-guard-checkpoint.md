# Dashboard cache: rolling-overlap guard (October 30 UTC)

The program remains active and incomplete. Faster-dashboards slice G1 implements
the follow-on guard that
[ADR 0072](../adr/0072-serving-cohort-coherence.md#follow-on-guard) decided for
the default-off chart cache. During a rolling deploy two API processes serve at
once, and a flag-on predecessor cannot see the successor's writes until its own
entries expire. The guard narrows that window. API paths are relative to
`apps/api/src/`.

The guard has three parts:

- **Shutdown-start retirement.** At SIGTERM the process stops serving and
  storing retained bodies before shutdown's first await.
- **Admission-time quarantine.** A new process retains nothing until 420 s
  after it starts listening. The first request admitted after that runs the
  app's full local retirement once.
- **Startup cohort record.** One log line at listen names the revision, the
  flag, the writer set and the quarantine end.

Every entry point is a no-op while `USER_CACHE_ENABLED` is off, and the flag
stays off in production, so production behavior does not change. No provider
setting, flag, migration or infrastructure change is included. G1 is stacked on
DA4 ([PR #833](https://github.com/ReSpOnSeSC2/sc2tools/pull/833)) and merges
after it.

## What changed

- `middleware/userCacheGuard.js` (new) holds the three entry points and two
  constants.
  - `QUARANTINE_MS` is 420 s (`middleware/userCacheGuard.js:10-12`).
  - `WRITER_SET_VERSION` names the in-process writer set (`:13-15`). Any change
    to a covered input's writers bumps it in the same pull request, and ADR
    0072's update rule now says so.
  - `beginChartCacheShutdown` marks the cache closing and drops every entry
    (`:17-22`).
  - `startChartCacheQuarantine` sets the quarantine end and logs
    `chart_cache_cohort_start`. That record holds the source revision (or
    null), `userCacheEnabled: true`, the writer-set version, the quarantine
    length and its end. The log call is wrapped so the record never fails boot
    (`:24-34`).
  - `retentionOpen` decides at admission, before the snapshot. It returns false
    while the cache is closing or quarantined. The first call after the end runs
    every `UserRevision` invalidator with null once (`:36-47`).
- `middleware/userCache.js`. Each hook is appended to an existing line, so no
  cited line moves:
  - admission asks `retentionOpen`, and a closed decision yields no key
    (`middleware/userCache.js:117,121,256`);
  - a response sent after the signal carries no validator (`:167`);
  - nothing is stored after the signal (`:264`).
- `server.js` starts the quarantine in the listen callback (`server.js:218`) and
  retires the cache on the `shutdown_start` line (`:418`).

### What the end of the quarantine retires

`retire(null)` replaces the epoch, clears every token and runs every
invalidator with null (`util/userRevision.js:28-39`). G1 runs only the
invalidators. No request admitted during quarantine can retain a body or get a
validator, so keeping `UserRevision`'s epoch and tokens refuses no chart
request.

The app's invalidator is still a full local retirement (`app.js:1011-1019`). It
clears the TrendsRequests joins and the owner revisions that session-policy
leases are taken from, and it discards pending session-gate work. A
session-policy read in flight at that instant can therefore fail once:

- momentum, today's session, session history or a `/me` session read gets 409
  `session_policy_changed`;
- a gate computation fails with `SESSION_RESOLUTION_STALE`, which surfaces as a
  500 where nothing catches it.

Any full local retirement does the same, for example the one a revision-map
overflow triggers. The real-app test pins this behavior. A reuse-only retirement
would avoid it, and the activation review should weigh one.

### The 420-second bound

A process cannot observe its predecessor's SIGTERM. The quarantine therefore
starts at listen, which comes before the health check passes and therefore
before the platform can signal the predecessor. It covers the predecessor's
assumed 300-second shutdown bound plus a 120-second margin for the health check
and the signal. An activation receipt must observe the predecessor's
`shutdown_start` within 120 s of the successor's startup line, as ADR 0072
requires.

## Accepted residual

G1 does not hold the successor's background writers until the process is
healthy. Custom-build reclassification recovery and the opponent-MMR job both
start at boot with no health gate and can write before the process is healthy
(`server.js:205-207,289`). Until its SIGTERM, a flag-on predecessor can
therefore serve a body that is stale by those writes, for at most the
successor's start-to-healthy time plus the signal delay. A successor that never
becomes healthy sends no signal at all. The predecessor can then stay stale for
the whole G4 window: 600 s after each store, plus the computation and any
adopted join age.

This review accepts that residual for source only. Before activation the owner's
review must accept it again, or a later slice must hold those writers. ADR
0072's receipt row says the same.

## Tests

`apps/api/__tests__/userCacheGuard.test.js` (new) has nine cases:

- with the flag off, every entry point is a no-op
  (`apps/api/__tests__/userCacheGuard.test.js:30-37`);
- after shutdown starts, no request gets a retained body or a 304, and correct
  200s continue (`:39-47`);
- work that finishes after shutdown starts is answered uncached for its
  initiator and for a joined follower (`:49-58`);
- a body delivered just before shutdown starts is still answered without a
  validator (`:60-65`);
- during quarantine nothing is retained or refused, the first request after it
  clears inner state once, and retention then resumes (`:67-79`);
- a request admitted during quarantine is never retained, even when its work
  ends after the quarantine (`:81-91`);
- the startup record carries only its five fields and never fails boot
  (`:93-104`);
- admission decides before the snapshot: a request whose snapshot outlasts the
  quarantine end is not retained (`:106-112`);
- `server.js` places both hooks at the right lines (`:114-121`).

`apps/api/__tests__/userCacheGuardApp.mongo.test.js` (new) runs the real app. The
first request after the quarantine runs the app's invalidator, retires a
session-policy lease taken before the end, and retention resumes
(`apps/api/__tests__/userCacheGuardApp.mongo.test.js:34-49`).

## Verification

Local checks ran at the G1 tested commit named in the receipt,
`docs/handoff/validation/dashboard-cache-overlap-guard/local-verification.json`.

- **API.** Whole-API types pass. Configured lint reports 758 warnings and 0
  errors, the same as C4. `userCache.js` and `server.js` add no configured or
  strict message; `send` keeps its complexity because the decision is passed
  into the key helper. The new module and suites pass strict lint.
- **Suites.** Thirty-six suites pass in band, on cached MongoDB 7.0.14 with
  downloads disabled. They are C4's thirty affected suites, the two guard
  suites and four `UserRevision` suites. No MongoDB process was left over.
- **Mutation.** 9 of 9 deliberate regressions are killed:
  - shutdown keeps the entries;
  - no validator strip;
  - stores while closing;
  - the quarantine is ignored;
  - the end keeps inner state;
  - the key ignores the decision;
  - the shutdown hook is unwired;
  - the guard acts with the flag off;
  - admission decides after the snapshot.
- **Review.** One independent read-only reviewer found that the end-of-quarantine
  retirement also retires session-policy leases, contradicting the earlier claim
  that no admitted request is refused. The claim is corrected here, in the
  module header and in ADR 0072, and the real-app test pins the behavior. It also
  found the untested admission order and the overstated "takes no key" wording;
  both are fixed.

## Limitations

- These are single-process tests. A real rolling deploy, the provider's health
  and signal timing, and the 300-second shutdown bound are observations for the
  activation receipt.
- The quarantine runs on the cache's wall clock, so a forward clock step at
  boot shortens it. Retention is open by default: a process built without
  `server.js` (tests and scripts) never starts a quarantine.
- The guard narrows G1-G3 in ADR 0072; it does not meet them. Writes from a
  flag-off process, an older writer set, out-of-band writes and failed bumps
  are still visible to a peer only through expiry.
- No activation, latency, request-reduction or savings claim.

## Remaining dashboard work

C5 (opponent-collection writers) and R1 (the activation review) remain. Before
activation the owner must accept the residual above, and G1-G3 stay unmet.
