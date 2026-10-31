# ADR 0073: Database backups use Atlas Cloud Backup

Status: Accepted, October 31, 2026. Documentation only. It changes no runtime
behavior, flag, provider, infrastructure or secret. It reconciles roadmap item
`db-offsite-backups` (ledger ordinal 12) with the project's accepted backup
architecture; it does not complete the item.

## Context

- **The literal plan.** The canonical plan
  (`docs/handoff/plan/final-plan.json:372-392`) was written on the premise that
  production ran a free-tier Atlas cluster, which "has no backups, and no
  workflow dumps the database". The same plan's `backup-status-honest-copy`
  item says the cluster "is M10 with Atlas Cloud Backup"
  (`docs/handoff/plan/final-plan.json:2581`). The plan specifies a nightly
  `mongodump` to a private R2 bucket with a manifest, a 7-daily, 4-weekly,
  6-monthly prune script, a weekly restore drill into a `mongo:7` container in
  CI, a single-user restore script, an admin backups endpoint and card with a
  stale alert, and honest Settings and privacy copy.
- **The accepted architecture.** The project's standing plan keeps "one Render
  instance (API), MongoDB Atlas **M10**" (`docs/handoff/HANDOFF.md:21`), and
  the last delivery checkpoint keeps costs "on the existing Render/Atlas
  M10/R2" (`docs/handoff/active-2026-10-27-delivery-checkpoint.md:88`). A
  dedicated M10 cluster can use Atlas Cloud Backup, which must be enabled with a
  snapshot schedule and retention set in Atlas
  (`docs/cloud/SETUP_CLOUD.md:63-71`). M0 free clusters have none.
- **The open requirement.** The ledger asks to "Reconcile the obsolete
  free-Atlas/nightly-R2-dump literal plan with the accepted M10 backup
  architecture" and, separately, for actual schedule, retention, freshness
  and restore-drill evidence
  (`docs/handoff/roadmap-progress-2026-10-28.json:479-482`).
- **A stale note.** `docs/DEPLOYMENT_GUIDE.md` carried a July 2026 "reality
  check" saying production runs a free-tier Atlas cluster. This ADR replaces
  it (`docs/DEPLOYMENT_GUIDE.md:3-12`).

## Decision

1. **Atlas Cloud Backup is the database backup system.** It covers every Mongo
   collection, including the `user_backups` metadata rows. The in-app snapshot
   archives are private R2 objects, not Mongo data
   (`docs/runbooks/user-snapshots.md:3-7`,
   `docs/adr/0026-streamed-user-snapshots.md:12-14`), so it does not cover
   them.
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
   | Weekly restore drill into `mongo:7`, with `verify-restore` | Not built. A drill needs an Atlas Project Owner (`docs/runbooks/restore-database.md:34-35`) and a restore target, such as a temporary cluster billed by the hour (`:128-139`), so it stays with the owner (below). |
   | `restore-user` script | In-app snapshots and the single-user restore runbook (`docs/runbooks/restore-database.md:39-104`). Their archives live in R2, which no system backs up (Consequences). |
   | Admin backups endpoint and card, with a stale alert | Admin → Infrastructure "Database backups" card, freshness bands from the reported policy (`apps/api/src/services/backupStatus.js:31-37`, `:309-336`) and an hourly `backup_stale` alert (`apps/api/src/jobs/backupHealthJob.js:5-12`). |
   | Honest Settings and privacy copy | Done as `backup-status-honest-copy` (ledger ordinal 101). The privacy page states the live retention through `GET /v1/site/data-retention` (`apps/web/components/legal/BackupRetention.tsx:8-16`). |

4. **What the public summary shows.** The production API answers
   `GET /v1/site/data-retention` (`apps/api/src/routes/me.js:94-99`) from the
   same read-only Atlas call, marking it available only when that call is
   current (`apps/api/src/services/dataInventory.js:61-70`). A read on
   October 31, 2026 at 21:39 UTC returned `available: true` with retentions of
   7 days, 7 days, 4 weeks, 12 months and 1 year, checked at 21:35 UTC
   (`docs/handoff/validation/db-backups/production-retention-20261031.json`).
   So Atlas returns a readable Cloud Backup policy for the configured cluster.
   The summary carries neither the cluster's Cloud Backup enabled flag nor any
   snapshot, and it does not say which frequency each retention belongs to;
   the admin card reads the enabled flag separately
   (`apps/api/src/services/atlasInfrastructure.js:474-481`) and shows a
   readable policy with backup off as its own state
   (`apps/web/app/admin/components/DatabaseBackupsCard.tsx:362-366`).

## What remains for the item

- **Freshness, the enabled flag and the tier.** The newest snapshot's age, the
  snapshot interval, whether Cloud Backup is on and the live cluster tier are
  on Admin → Infrastructure, which needs a signed-in admin. They were not read.
- **A successful restore drill.** An Atlas Project Owner restores the newest
  snapshot to a scratch target, or downloads it into a local `mongod`, compares
  collection counts with production and records the outcome. Not done.
- The item stays partial until these are recorded. No restore of production
  was attempted, and none is part of verifying this ADR.

## Consequences

- No new infrastructure, provider settings, credentials or workflows.
- Cloudflare R2 is backed up by neither system: original replays, replay
  details when stored there, and the in-app snapshot archives. Players rebuild
  replays and details with Re-sync (`docs/runbooks/restore-database.md:23-25`);
  a lost snapshot archive cannot be rebuilt, so an Atlas restore can bring back
  `user_backups` rows whose archives are gone.
- `docs/DEPLOYMENT_GUIDE.md`'s note now states the accepted M10 architecture and
  points here and at the Admin page instead of the July 2026 free-tier claim,
  and `docs/runbooks/restore-database.md` no longer says Atlas covers the
  snapshot archives.
