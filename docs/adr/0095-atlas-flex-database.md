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
   or 404 from that resource means "dedicated". Atlas keeps the name when it
   upgrades Flex to a dedicated tier in place, so a 400/404 from any read
   that assumed the cached kind drops the cache and the next call probes
   again. Any other probe failure keeps the last known kind for five minutes
   (so an outage costs one probe per window) and propagates only before a
   kind has been learned, so an outage is never read as a tier. A fresh
   probe's response doubles as the cluster read, a failed one is not
   repeated, and the invoice request runs alongside the probe. For Flex the
   client reports the provider settings only (no disk or host metrics) and
   reads backups from the Flex snapshot list, reporting the tier's fixed
   policy (daily, last 8 kept, no point-in-time restore).
3. The billing run rate is measured from the configured cluster's first line
   item to the end of its newest one (the invoice's own "updated" time moves
   whenever any line posts, so it only caps a line that claims to end later).
   A cluster that started mid-cycle is not diluted over days it did not
   exist. A Flex run rate stays within the tier's range for the cycle: never
   above the $30 cap, never below the base band's hourly price ($0.011) for
   the cycle's hours (a partly billed first day would otherwise pull it
   under, for the whole cutover month), with line discounts scaling that
   floor, and never below what has already posted. A definite tier from the
   probe decides whether that range applies; only when the tier is unknown do
   Flex SKUs on every matching line imply it, so a cluster upgraded in place
   (mixed Flex and dedicated lines) is never clamped. The billing payload
   says which of these set the number (`projectionBasis`), and the donate page
   words it accordingly. Flex SKUs count as compute: the band price includes
   storage, backups and transfer. Charges posted this cycle for the project's
   other clusters (for example the paused M10) are totalled for admins
   (`otherClustersPostedCents`, with a watch advisory); public pages count
   only the configured cluster.
4. The planning fallback, shown only while live billing is unavailable (for
   example before a new cluster's first day of charges posts), is the Flex base
   price of $8, so the public fixed baseline is $16.25 (Render $7, domain
   $1.25, Flex $8).
5. Admin capacity advice for Flex replaces the disk and CPU advisories, which
   Flex cannot supply, with a storage advisory against the 5 GB allowance
   (watch at 70%, upgrade at 80%, because Flex storage cannot expand). The
   allowance counts every database on the cluster, so the API sums `dbStats`
   data and index sizes over every database (`listDatabases` with
   `authorizedDatabases: false`, so a user scoped to its own database gets an
   error instead of a one-database listing that looks like the whole
   cluster). Names never leave the server, the commands are log-private, and
   the total is admin-only. If the read fails, the SC2 Tools database stands
   in as a labelled lower bound with a watch advisory whose text depends on
   the reason: a permissions gap names a metadata-only custom role
   (`listDatabases` plus `dbStats`, not the read-any roles), a transient
   failure keeps the last good total for a day. The figure is conservative:
   on cutover day Atlas's own Flex "data size" read 1.87 GB for the whole
   cluster while the SC2 Tools database's uncompressed `dbStats` alone was
   2.13 GB.
6. The public retention notice (privacy page, account-deletion dialog,
   goodbye page) keeps disclosing the previous cluster while it or its
   snapshots exist: that it holds a copy of accounts as of the move,
   including accounts deleted since, until the cluster is deleted, and that
   its backups last up to the longest entry of `LEGACY_BACKUP_RETENTION`
   (7 days, 4 weeks, 12 months, 1 year). Render ignores `sync: false` keys
   when it updates an existing Blueprint, so the operator sets the value in
   the dashboard together with `ATLAS_CLUSTER_NAME`, and removes it only
   after the old cluster and its snapshots are deleted. The privacy page's
   "last updated" date moved with this change.

## Consequences

- The public cost display drops from about $91 to about $16-23 a month.
- Backups: daily snapshots, the last 8 kept, no point-in-time restore and no
  on-demand snapshots. The privacy page's retention line follows the API: 8
  days for the current database, plus the previous cluster's disclosure while
  `LEGACY_BACKUP_RETENTION` is set. The restore runbook's point-in-time steps
  do not apply.
- Until the M10 is deleted, it also holds a frozen copy of every account as of
  cutover, including accounts deleted afterwards, so deleting it (with its
  snapshots) promptly after the rollback window is what ends that copy. A
  paused M10 still bills storage and backups, and Atlas resumes a paused
  cluster after 30 days.
- Capacity: 5 GB including indexes, counted over every database on the
  cluster (the SC2 Tools database alone was about 45% at cutover), 500
  operations per second, and no disk spill for aggregations (in-memory sort
  limit 32 MB).
  The admin Global Trends history build sorts more than 32 MB and needs a
  follow-up before that admin page works on Flex; user-facing pages were
  checked against the limits.
- Atlas schedules Flex upgrades; the Node driver (6.13) is supported for 8.0.
- The M10 stays paused for a rollback window before it is deleted. Other
  applications' databases were copied to Flex as well and must be repointed
  before the M10 is removed.
