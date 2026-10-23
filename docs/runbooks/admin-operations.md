# Admin operations

## Job health

Open Admin → Infrastructure → Background jobs. The process registers operational
workers with a shared `instrumentJob(name, intervalMs, tick)` wrapper. It preserves
the work's result/error and existing schedules, locks and freshness checks. A
failed ledger insert never causes work to retry or roll back. The private
`job_runs` collection is capped at 5,000 documents and 8 MiB (whichever limit is
reached first). Rows contain timestamps, duration, status, safe error codes and
bounded numeric/boolean counters; no user IDs, provider responses or URLs.

Statuses are `ok`, `error`, `lock_held`, and `disabled`. Caught worker failures are
reported to the wrapper rather than recorded as a false success. Last OK and
last error refer to retained history; a missing row can mean a fresh process,
retention or a failed observation write. The sparkline shows the last 12 retained
run durations. The next-due time is the configured cadence, not an execution
promise. Feature-gated scheduled work displays its flag; Guides can still be
prepared through the existing explicit admin recompute path when public guides
are off. An environment soft-disable remains respected.

The observed workers cover keepalive, session refresh, support email, Pulse
backfill, opponent MMR enrichment, ladder map refresh/backfill, league percentiles,
fingerprint calibration, ladder meta, review digest, backup health, guide stats,
guide videos, Trends materialization and identity-deletion retries. Successful
high-frequency Trends batches are sampled once per five minutes so observation
does not add one Mongo write per batch; errors still record immediately. The ladder-map backfill is a one-shot boot operation with manual rerun; it has
no next-due time and cannot raise an overdue alert. First-delay jobs show their
configured startup delay before the first tick. Socket
heartbeats, lease-renewal timers and provider chat transports retain their own
existing lifecycle diagnostics.

A once-per-minute in-process monitor raises one `job_overdue` admin event per
job/UTC day after three intervals without an OK run. Disabled/unscheduled jobs
do not alert. Duplicate delivery is guarded by the existing admin-event ingestion
key index. The monitor uses no new service, scheduler or provider polling.

## Re-running a job

Read the last error and environment flag first. Run now is available only for
registered manual operations. Confirming it executes real configured work,
joining the scheduler's single flight and respecting distributed locks and
freshness checks; it does not override them. Revalidation shows the resulting
history row. A rejected or failed run stays visible in the confirmation for
retry. This development work did not run production jobs.

## Audit log

Admin → Audit log filters retained administrator mutations by action and target.
The shared middleware covers admin mutation routes, including domain routers,
and records actor ID, route/action, target, HTTP result and allowlisted counters.
A wipe records the actual games deleted. Request bodies, emails, tokens and query
strings are excluded. Compound cursors keep concurrent actions at the same
millisecond traversable. Rows expire after 400 days; observation remains best
effort, so a missing row cannot prove that an action never ran.

Audit writes acquire the same shared user-data leases as other account writes.
Account erasure drains them, exports only the requesting identity, and anonymizes
retained actor/target IDs under the exclusive fence before removing the account.
Late writes for missing/erasing identities are anonymized before insertion.
Neither observation nor erasure removes a GDPR lock to gain access.

## Support snapshot and repairs

Use [Repairing a user's data](../admin-console.md#repairing-a-users-data) for
resolved-user lookup, rebuild versus wipe, typed confirmation and result checks.
Rebuild takes a pre-action snapshot and the same exclusive owner mutation fence
as self-service repair. It fails closed if that snapshot cannot be saved; it
never races a concurrent upload or erasure by clearing its lock.

The user detail snapshot includes devices/version/online state, doctor warnings,
archive counts, last five import jobs and recent target audit rows. The API is
private/no-store and does not expose token hashes, support text or replay paths.

Admin wipe deletes all history. For a date-limited request, use the existing
Settings → Backups & data → Delete game history controls with the intended dates;
never replace a date-limited request with an all-history admin wipe. Wipes retain
their scope and bounds in `gdpr_games_wiped`. After a database restore, reapply
that same scope; see [Restore database](restore-database.md). Restoring Mongo
cannot restore already-deleted R2 objects. No production wipe/restore was used
for development or validation.

## Activation funnel

Open Admin → Web analytics → Activation. This first-party view works without GA
consent or credentials. It considers the newest 2,000 signups in 1–26 UTC signup
weeks (default eight), reports truncation and caches/coalesces each window for
one hour. A stalled user has signed up at least 24 hours ago without pairing or
stored games; up to 50 are shown. Opening the list sends nobody a message.

- Signup: a `users.createdAt` record, grouped by UTC Monday.
- Download: an observed authenticated installer hand-off. The website records
  first `activation.downloadedAt` after validating the installer target. A missing
  session or attribution failure never prevents the existing installer redirect
  or its ordinary download event. Historical anonymous clicks cannot be assigned
  to a signup, and download does not mean installation.
- Paired: a device token was issued; this is distinct from a confirmed heartbeat.
- First game and ten games: saved game analysis. Time to first game uses the
  server's ingest `createdAt`, not an old replay's played date.
- Week-two return: an authenticated visit, a known heartbeat still in that window,
  or an ingest during days 7–13 after signup. Recent visits record the first return
  atomically without replacing future activation fields. Historical overwritten
  heartbeats cannot be reconstructed. Only users at least 14 days old enter this
  denominator; later activity does not erase a proven week-two ingest/visit.

Median hours use observed non-negative intervals. Each column is an independently
observed milestone, so partial historic instrumentation can make counts
non-monotonic; do not infer that every paired user clicked the tracked download.
The read disclosure repeats these definitions beside the table.

## Migration and rollback

Boot creates the new capped `job_runs` collection and normal `admin_audit`
collection with its 400-day TTL and query indexes. There is no user-data backfill
and no destructive migration. Actor/target anonymization and the shared erasure
lease integration must remain if rolling back the UI. Stop the new monitor on
shutdown. Existing workers keep their prior timers and can run without an
injected ledger. Preserve frozen snapshot/identity-deletion guards and retry
queues; do not delete locks, pending erasure intents, or restore erased data to
undo this operations feature.
