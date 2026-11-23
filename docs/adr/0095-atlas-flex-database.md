# ADR 0095: The production database moves to Atlas Flex

Status: Accepted, November 23, 2026. Supersedes the M10 hosting assumption in
ADR 0073 (`docs/adr/0073-database-backups-atlas-cloud-backup.md`); Atlas
remains the backup provider, now with the Flex tier's fixed snapshot policy.

## Context

- **Cost.** The dedicated M10 (`vacation-rental`, Google Cloud Oregon, MongoDB
  8.0.39) was the largest hosting cost: about $83 a month (compute about $59,
  Cloud Backup snapshot storage about $13, data transfer about $11), while the
  application database is 2.13 GB of documents and 117 MB of indexes.
- **Fit.** Atlas Flex costs $8 to $30 a month (hourly by operations-per-second
  band, capped at $30), includes 5 GB of data (uncompressed documents plus
  indexes), daily backups and data transfer, and runs MongoDB 8.0. Flex is not
  offered in Google Cloud Oregon, so the cluster (`unified-flex`) runs in AWS
  `us-west-2`, next to Render's Oregon region.
- **Verified before cutover** (rehearsal plus final copy, all databases): the
  hello fields the game-stats read floor requires (set name, writable primary,
  logical session timeout, wire version, topology version, operation time),
  snapshot multi-document transactions with majority and journaled commits and
  causal majority reads, capped-collection creation (`job_runs`), and exact
  per-collection document, index and capped-flag parity.
- **The Atlas integration assumed a dedicated cluster.** The classic clusters
  Admin API no longer serves Flex clusters, the cost projection spread a
  cluster's charges from the start of the billing cycle (a cluster created
  mid-cycle would have shown about $0.40 a month), and the planning fallback
  was the M10 list price.

## Decision

1. Production uses the Flex cluster `unified-flex` in the existing Atlas
   project. `MONGODB_URI` points at it and `ATLAS_CLUSTER_NAME` names it.
2. `AtlasInfrastructureClient` detects a Flex cluster through the Flex Admin
   API resource (version 2024-11-13) and caches the kind for six hours. A 400
   or 404 from that resource means "dedicated"; any other failure propagates so
   an outage is never read as a tier. For Flex it reports the provider settings
   only (no disk or host metrics) and reads backups from the Flex snapshot list,
   reporting the tier's fixed policy (daily, last 8 kept, no point-in-time
   restore).
3. The billing run rate is measured from the configured cluster's first line
   item, so a cluster that started mid-cycle is not diluted over days it did not
   exist, and a Flex projection never exceeds the $30 cap. Flex SKUs count as
   compute: the band price includes storage, backups and transfer.
4. The planning fallback, shown only while live billing is unavailable (for
   example before a new cluster's first day of charges posts), is the Flex base
   price of $8, so the public fixed baseline is $16.25 (Render $7, domain
   $1.25, Flex $8).
5. Admin capacity advice for Flex replaces the disk and CPU advisories, which
   Flex cannot supply, with a storage advisory against the 5 GB allowance using
   the application database's own `dbStats` (watch at 70%, upgrade at 80%,
   because Flex storage cannot expand).

## Consequences

- The public cost display drops from about $91 to about $16-23 a month.
- Backups: daily snapshots, the last 8 kept, no point-in-time restore and no
  on-demand snapshots. The privacy page's retention line follows the API and
  now reads 8 days. The restore runbook's point-in-time steps do not apply.
- Capacity: 5 GB including indexes (about 45% used at cutover), 500 operations
  per second, and no disk spill for aggregations (in-memory sort limit 32 MB).
  The admin Global Trends history build sorts more than 32 MB and needs a
  follow-up before that admin page works on Flex; user-facing pages were
  checked against the limits.
- Atlas schedules Flex upgrades; the Node driver (6.13) is supported for 8.0.
- The M10 stays paused for a rollback window before it is deleted. Other
  applications' databases were copied to Flex as well and must be repointed
  before the M10 is removed.
