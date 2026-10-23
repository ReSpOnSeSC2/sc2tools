# Observed admin operations

Reuse the existing process schedules and each worker's lock/freshness policy.
The shared wrapper coalesces scheduled/manual invocations and writes a best-effort
bounded run ledger; caught errors explicitly mark failure. High-frequency Trends
successes are sampled every five minutes. A small memory-only minute monitor
raises idempotent overdue events through the existing durable admin feed. No new
infrastructure, cron service or AI calls are introduced.

Admin mutations are observed across all domain routers with allowlisted counters,
not copied request/response bodies. A 400-day TTL bounds retention. Compound
cursors preserve equal-time actions. Shared actor/target user-data leases exclude
account erasure; retained rows are anonymized under its exclusive fence. Failed
observability cannot retry a successful mutation or clear a GDPR lock.

Admin role removal runs in a Mongo transaction, writing a shared revision before
counting roles so concurrent removals conflict and retry against fresh state.
Self, last-admin and configuration-protected role removals are refused. Replica
set support is required (Atlas in deployment; MongoMemoryReplSet in tests).

Cohorts use first-party observed milestones, a hard 2,000-signup cap, indexed
owner aggregations and one-hour cache/coalescing. Signed-in installer hand-offs
are recorded separately from ordinary download totals. Historical anonymous
clicks are explicitly unattributable. Ingest timestamps, actual week-two activity
and field-only activation updates avoid guessed conversions or lost future
preferences. No support outreach or production mutation was performed.

The repair UI resolves a real user before enabling actions, uses shared state
and result components, and requires typed email/ID for an all-history wipe. The
confirmed game count is checked under the exclusive fence before a snapshot or
deletion begins. A changed count returns 409 with history untouched.

Coverage: this change completes `ops-console`, its folded
`admin/tools-user-lookup` augment and its how-to. `admin-polish-4`, `-5`, `-6`
and `-7` remain separate packs; their URL/table, game browser, inbox read controls
and triage dashboard are not claimed here.
