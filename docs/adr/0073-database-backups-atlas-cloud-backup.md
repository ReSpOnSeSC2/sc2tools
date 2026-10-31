# ADR 0073: Database backups are Atlas Cloud Backup on the M10 cluster

Status: Accepted, October 31, 2026. Documentation only. It changes no runtime
behavior, flag, provider, infrastructure or secret. It reconciles roadmap item
`db-offsite-backups` (ledger ordinal 12) with the backup architecture the
project runs; it does not complete the item.

## Context

- **The literal plan.** The canonical plan
  (`docs/handoff/plan/final-plan.json:372-392`) was written when production
  ran a free-tier Atlas cluster: its stated reason is that free-tier Atlas
  "has no backups, and no workflow dumps the database". It specifies a nightly
  `mongodump` to a private R2 bucket with a manifest, a 7-daily, 4-weekly,
  6-monthly prune script, a weekly restore drill into a `mongo:7` container in
  CI, a single-user restore script, an admin backups endpoint and card with a
  stale alert, and honest Settings and privacy copy.
- **The accepted architecture.** The project's standing plan keeps "one Render
  instance (API), MongoDB Atlas **M10**" (`docs/handoff/HANDOFF.md:21`), and
  the last delivery checkpoint keeps costs "on the existing Render/Atlas
  M10/R2" (`docs/handoff/active-2026-10-27-delivery-checkpoint.md:88`). A
  dedicated M10 cluster has Atlas Cloud Backup, which snapshots the whole
  cluster on the schedule and retention set in Atlas
  (`docs/cloud/SETUP_CLOUD.md:63-71`). M0 free clusters have none.
- **The open requirement.** The ledger asks to "Reconcile the obsolete
  free-Atlas/nightly-R2-dump literal plan with the accepted M10 backup
  architecture" and, separately, for actual schedule, retention, freshness
  and restore-drill evidence
  (`docs/handoff/roadmap-progress-2026-10-28.json:479-482`).
- **A stale note.** `docs/DEPLOYMENT_GUIDE.md:3-10` still carries a July 2026
  "reality check" saying production runs a free-tier Atlas cluster. This ADR
  replaces it.

## Decision

1. **Atlas Cloud Backup on the M10 cluster is the database backup system.**
   It covers every collection, including the in-app `user_backups` snapshots
   (`docs/runbooks/restore-database.md:12-25`).
2. **The nightly R2 dump is not built.** It would be a second backup system,
   and it needs a new R2 bucket, new write and read credentials and a
   scheduled workflow: new infrastructure, provider settings and secrets that
   this program does not authorize. An off-provider copy, if the owner wants
   one later, is a new decision with its own ADR.
3. **Each part of the plan maps to what exists**, or is recorded as not done:

   | Plan (`final-plan.json:372-392`) | Now |
   | --- | --- |
   | Nightly `mongodump` to private R2, with a manifest | Atlas Cloud Backup's scheduled cluster snapshots. `apps/api/src/services/backupStatus.js:7-22` reads the snapshots and the policy through the read-only service account. |
   | Prune to 7 daily, 4 weekly and 6 monthly | The retention set in Atlas's backup policy (production reading below). |
   | Weekly restore drill into `mongo:7`, with `verify-restore` | Not built. A drill needs an Atlas Project Owner and a restore target (`docs/runbooks/restore-database.md:34-35`), so it stays with the owner (below). |
   | `restore-user` script | In-app snapshots and the single-user restore runbook (`docs/runbooks/restore-database.md:39-104`). |
   | Admin backups endpoint and card, with a stale alert | Admin → Infrastructure "Database backups" card, freshness bands from the reported policy (`apps/api/src/services/backupStatus.js:31-37`, `:309-333`) and an hourly `backup_stale` alert (`apps/api/src/jobs/backupHealthJob.js:5-12`). |
   | Honest Settings and privacy copy | Done as `backup-status-honest-copy` (ledger ordinal 101). The privacy page states the live retention through `GET /v1/site/data-retention` (`apps/web/components/legal/BackupRetention.tsx:8-16`, `apps/api/src/services/dataInventory.js:61-70`). |

4. **Evidence of the configured policy comes from the public summary.** The
   production API answers `GET /v1/site/data-retention` from the same
   read-only Atlas call, reporting a policy only when that call is current
   (`apps/api/src/routes/me.js:94-99`). A read on October 31, 2026 at 21:39
   UTC returned `available: true` with retentions of 7 days, 7 days, 4 weeks,
   12 months and 1 year, checked at 21:35 UTC
   (`docs/handoff/validation/db-backups/production-retention-20261031.json`).
   So Cloud Backup is on and its policy is readable. The summary does not
   say which frequency each retention belongs to.

## What remains for the item

- **Freshness.** The newest snapshot's age and the snapshot interval are on
  Admin → Infrastructure, which needs a signed-in admin. They were not read.
- **A successful restore drill.** An Atlas Project Owner restores the newest
  snapshot to a scratch target, or downloads it into a local `mongod`, compares
  collection counts with production and records the outcome. Not done.
- The item stays partial until both are recorded. No restore of production was
  attempted, and none is part of verifying this ADR.

## Consequences

- No new infrastructure, provider settings, credentials or workflows.
- Cloudflare R2 (original replays and, when configured, replay details) is
  still backed up by neither system; players rebuild it with Re-sync
  (`docs/runbooks/restore-database.md:23-25`).
- `docs/DEPLOYMENT_GUIDE.md`'s note now states the M10 architecture and points
  here and at the Admin page instead of the July 2026 free-tier claim.
