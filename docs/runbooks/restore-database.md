# Runbook: restore the database

How to get data back, from the smallest fix to the largest. Pick the
first section that fits; a whole-cluster restore is the last resort.

| Situation | Use |
| --- | --- |
| One user wants their account back to an earlier state | [Single-user restore](#single-user-restore-from-an-in-app-snapshot) from one of their in-app snapshots |
| Bad deploy, migration or script damaged data for many users | [Atlas restore](#atlas-restore-whole-cluster), point-in-time if it's on |
| Cluster lost or corrupted | [Atlas restore](#atlas-restore-whole-cluster) from the newest good snapshot |

What is and isn't backed up:

- **Atlas Cloud Backup** snapshots the whole MongoDB cluster on the
  schedule set in Atlas (cluster → Backup → Backup Policy). That covers
  every collection, including the in-app `user_backups` snapshots.
- **In-app snapshots** (`user_backups`, Settings → Backups & data) are
  private, streamed gzip NDJSON copies with metadata in Mongo. See
  [User snapshots](user-snapshots.md) for format, migration, retention and
  rollback compatibility. They don't hold replay-detail blobs
  (`buildLog`, `macroBreakdown`, `apmCurve`, `mapPlayback`) or original
  replay files.
- **Cloudflare R2** (original replays, and replay details when
  `GAME_DETAILS_STORE=r2`) is **not** backed up by either. Users rebuild
  it by pressing Re-sync in the desktop app, from the replays on their PC.

## Before you start

1. Open **Admin → Infrastructure → Database backups**. It shows the age of
   the newest Atlas snapshot, the next scheduled one, retention and
   whether point-in-time restore is on. If it says "Not connected", the
   `ATLAS_*` settings aren't set in Render; read the same facts on the
   cluster's **Backup** page in Atlas instead.
2. Restoring needs a person with the **Project Owner** role in Atlas. The
   app's service account is read-only on purpose and can't restore.
3. Write down the time you want to go back to, in UTC, and why. You need
   it for the restore and for the clean-up afterwards.

## Single-user restore from an in-app snapshot

The user can do this themselves, and that is the preferred path: Settings
→ Backups & data → Snapshots → **Restore**. It replaces their games list,
opponents, notes, custom builds and settings with the snapshot's copy and
keeps current replay-detail data and R2 replay files for game IDs present
in both lists. The verified preview shows games kept, removed and added.
Only games absent from the snapshot lose their current files. A fresh
pre-action snapshot is saved before changes. Re-sync is needed for files
that were already absent from current data, not for every retained game.

If you must do it for them (for example they can't sign in):

1. Find the user's internal id (`userId`, a UUID) on **Admin → Users**.
2. List their snapshots from a shell with the API's environment (Render →
   the API service → **Shell**):

   ```sh
   cd apps/api
   node -e '
   const { MongoClient } = require("mongodb");
   (async () => {
     const client = await MongoClient.connect(process.env.MONGODB_URI);
     const rows = await client.db(process.env.MONGODB_DB || "sc2tools_saas")
       .collection("user_backups")
       .find({ userId: process.argv[1] }, { projection: { _id: 0, id: 1, createdAt: 1, sizeBytes: 1 } })
       .sort({ createdAt: -1 }).toArray();
     console.table(rows);
     await client.close();
   })();
   ' <userId>
   ```

3. With explicit authorization to restore that account, first preview it
   through the same service as Settings. The following command is read-only
   for account data (it validates through temporary staging):

   ```sh
   cd apps/api
   node -e '
   const pino = require("pino");
   const { loadConfig } = require("./src/config/loader");
   const { connect } = require("./src/db/connect");
   const { buildApp } = require("./src/app");
   (async () => {
     const config = loadConfig();
     const db = await connect({ uri: config.mongoUri, dbName: config.mongoDb });
     const { services } = buildApp({ db, logger: pino({ level: "warn" }), config });
     console.log(await services.gdpr.backups.preview(process.argv[1], process.argv[2]));
     await db.close();
     process.exit(0);
   })().catch((err) => { console.error(err); process.exit(1); });
   ' <userId> <snapshotId>
   ```

   Review the full diff and record `currentRevision`. A `snapshot_not_found`
   means the ID is not owned by that user; `backup_migration_required` means
   the legacy payload needs the separately authorized migration first.
4. Only after reviewing the preview and obtaining any needed authorization,
   repeat the command with its service call replaced by
   `services.gdpr.restoreSnapshot(process.argv[1], process.argv[2], process.argv[3])`
   and pass `<userId> <snapshotId> <currentRevision>`. It prints `restoredAt`
   and final counts. If `backup_preview_changed` occurs, preview again and
   review the updated diff; do not omit the revision to bypass it.
5. Explain which games/files survived and which need desktop **Re-sync**.

## Atlas restore (whole cluster)

A restore rolls **every** user back to the chosen time. Anything written
after it (new games, builds, settings, account deletions) is lost from
Mongo. Prefer restoring into a separate cluster first, check it, then
switch over.

### 1. Freeze writes

Suspend the API in Render (the service → **Settings** → **Suspend
Service**) so agents and browsers stop writing while you work. Agents
retry failed uploads with backoff and catch up once the API is back.

### 2. Restore

On the cluster's **Backup** page in Atlas:

- **Point-in-time** (only when Continuous Cloud Backup is on; the admin
  card shows the window): choose **Point in Time Restore**, enter the UTC
  time from "Before you start", and pick the target cluster.
- **Snapshot**: under **Snapshots**, pick the newest snapshot taken
  before the damage and choose **Restore**, then the target cluster.

Target cluster:

- **Recommended:** a new cluster in the same project, same tier and
  MongoDB version (for example `sc2tools-restore`). Check it (step 3),
  then either restore the same snapshot over production, or point
  Render's `MONGODB_URI` at the new cluster and retire the old one.
  Delete the temporary cluster afterwards; it is billed by the hour.
- **Directly over production** when the cluster is lost or time matters
  more than a second look. Atlas overwrites everything on the target.

The target needs at least as much disk as the source and the same or a
newer MongoDB major version.

### 3. Check the restored data

Connect with `mongosh` to the target and spot-check:

```js
use sc2tools_saas
db.users.countDocuments()
db.games.countDocuments()
db.games.find({}, { date: 1 }).sort({ date: -1 }).limit(1)   // newest game ≈ the restore time
db.custom_builds.countDocuments()
```

### 4. Bring the API back

The game-statistics writer protocol does not make an Atlas restore or raw
collection replacement an application-level snapshot restore. Raw restores can
rewind `users.gameStatsMutationEpoch`, `gameStatsRevision` and protocol metadata
alongside games. Keep every old API process, script and migration stopped until
its outstanding writes have an authoritative settled outcome. The
`game_stats_writers_drained` log only proves local promises settled; an unknown
commit acknowledgement is not proof of rollback or server settlement.

This release still uses the authoritative count/latest queries and introduces
no retained statistics reader. Before adding such a reader, its rollout must
prove retirement/rebuild of restored authority for every owner and serving
process, including a fresh mutation epoch. Never clear the epoch back to
missing, restore it from an in-app snapshot, or use a restored protocol marker
as proof that old writers have stopped. The manual drop/`$out` rollback in the
timebase migration has the same boundary. `USER_CACHE_ENABLED` stays off.

Resume the Render service (or redeploy if `MONGODB_URI` changed). Boot
recreates any missing indexes. Then confirm:

- `GET /v1/health` answers 200.
- **Admin → Infrastructure**: MongoDB ping is green and Database backups
  reads Atlas again.
- Sign in as a normal user and open the analyzer.

### 5. Clean up what the restore can't know about

- **Account deletions after the restore point come back.** Search the
  Render logs from the restore time onward for `gdpr_account_deleted` and
  delete each listed `userId` again, through the app's service:

  ```sh
  cd apps/api
  node -e '
  const pino = require("pino");
  const { loadConfig } = require("./src/config/loader");
  const { connect } = require("./src/db/connect");
  const { buildApp } = require("./src/app");
  (async () => {
    const config = loadConfig();
    const db = await connect({ uri: config.mongoUri, dbName: config.mongoDb });
    const { services } = buildApp({ db, logger: pino({ level: "warn" }), config });
    console.log(await services.gdpr.deleteAll(process.argv[1]));
    await db.close();
    process.exit(0);
  })().catch((err) => { console.error(err); process.exit(1); });
  ' <userId>
  ```

  Also search for `gdpr_games_wiped` (history wipes, including admin wipes).
  Preserve the original scope: `since` is inclusive and `until` is exclusive.
  Re-run a range only with its logged bounds, converting non-null strings to
  `Date` values, for example:

  ```js
  await services.gdpr.wipeGames(userId, {
    since: new Date("2026-10-01T00:00:00.000Z"),
    until: new Date("2026-10-11T00:00:00.000Z"),
  });
  ```

  Older user-wipe logs may have the bounds under `counts.range`. Use `{}`
  only when the log explicitly records `scope: "all"` or a range with both
  bounds null. If the scope or either bound is missing or unclear, ask the
  user to repeat the intended wipe. Never guess a range or replace it with
  an all-history wipe: that also permanently deletes replay files and R2
  detail blobs outside the intended range. Admin wipes before this audit
  update were not logged; reconcile those with the admin and affected users.
- **R2 is not rolled back.** Games deleted after the restore point come
  back in Mongo but their replay files and R2 detail blobs are gone; games
  created after it have R2 objects with no Mongo row (harmless orphans).
  Post a short notice asking users to press **Re-sync** in the desktop
  app; it re-uploads anything missing without duplicating games.
- Note the incident, the restore time used and what was lost in the
  admin notes or an issue, so support can answer users.
