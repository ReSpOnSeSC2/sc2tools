# User snapshots and safe restore

User snapshots use the existing private R2 configuration (`R2_ENDPOINT`, bucket and credentials). No new infrastructure or scheduler is required. Without configured storage, manual and pre-action snapshots return `backups_unavailable`; restore, wipe and self-service repair fail before changing covered data.

## Stored format and retention

Objects are `user-backups/{encoded userId}/{id}.ndjson.gz`. Gzip NDJSON has an identity/version header, a collection header followed by cursor rows for each restorable collection, and a final counts/SHA-256 record. BSON Extended JSON retains dates. Multipart buffers are 8 MiB and only two uploads run per API process. Mongo `user_backups` keeps owner-scoped metadata, not payloads. Retain the newest five manual, two weekly automatic and three pre-action snapshots independently; a failed object prune is logged and retried by a later creation.

Weekly creation is lazy on successful ingest, with an ISO-week Monday/UTC CAS and a lease on `users.backups`. It permits later import batches to continue, so automatic backups are cursor captures across collections rather than cross-collection transactions. Manual and pre-action captures hold the exclusive GDPR fence. No cron is added.

## Restore protocol

1. Stream and verify the entire private archive into `backup_restore_staging`, with a 24-hour TTL for crash residue. No game is deleted during validation or preview. The staging operation is scoped to its random ID and owner, with indexed game membership.
   Preview briefly holds the exclusive fence while counting current membership, then returns `currentRevision`. The web sends it back on restore. If game IDs changed in between, restore returns `backup_preview_changed` before pre-action capture/deletion and the dialog refreshes its preview. Older API callers may omit the revision for compatibility.
2. Read current markers for the intersection of game IDs. Run at most eight concurrent HEAD checks; retain only verified current replay markers. Preserve current game details and playback artifacts for intersection games.
3. Save a new `pre_action` snapshot. Failure aborts before deletion.
4. Delete raw replays, playback artifacts and game details only for current games absent from the snapshot, in bounded batches. Restore slim rows and covered collections; clear obsolete macro jobs and classifier work. New game revisions invalidate stale classifier results.
5. Restore ordinary preferences and editable profile fields with literal field updates. Identity, roles, pairing credentials, onboarding goals/progress, notification choices and unknown future preference groups survive. Import history, public/community and shared coaching records are not restored. Scrub derived guide samples/examples.

Restore is synchronous and returns final counts. It does not require a replica-set transaction. Its pre-action backup is the recovery path for a process failure partway through the bounded Mongo writes; inspect state before another restore. A snapshot does not contain heavy details or replay binaries, so an already deleted file needs desktop Re-sync even when its slim game is restored.

Authenticated writes to covered HTTP paths hold expiring `_dataMutations` leases on the same user row as `_gdprMutation`. They never remove a GDPR lock. GDPR waits for active writes/coaching mutations before claiming its exclusive lease. A disconnected request keeps its expiring write lease because its handler may still be writing. Classification and opponent-build writers are drained/cancelled before manual capture or restore. Shutdown drains accepted repairs and automatic backups before closing Mongo.

## Migrate embedded snapshots

The one-off script defaults to a read-only count:

```powershell
node apps/api/scripts/migrate-user-backups.js
```

Review the target environment and count before an explicitly authorized apply:

```powershell
node apps/api/scripts/migrate-user-backups.js --apply
```

Apply processes one legacy document at a time under the user's mutation fence. It preserves ID/type/creation date, completes the R2 upload, then replaces the embedded payload with metadata. A failed upload retains the old payload. Restarting skips migrated documents. Verify metadata and a private download in a non-production fixture; never run a production restore as a migration check. Legacy rows return `backup_migration_required` for download/preview/restore until migrated. No migration or restore has been executed against production by this change.

## Repairs and account erasure

`POST /v1/me/repair/{opponents|replay-archive|custom-builds}` takes a pre-action backup and returns 202. Each kind uses a one-hour CAS on `users.repairs`, holds the GDPR fence until completion, records status and emits one idempotent in-app `data.repair` notification. A setup failure before acceptance releases the attempt so it can be retried. There is no external message delivery.

Account erasure checks backup storage before primary purges, deletes the entire owned object prefix (including objects without metadata), metadata and owned staging residue. Other users' prefixes survive. Classify staging as `ttl_ephemeral`; `user_backups` remains user-scoped metadata. Signed downloads expire after 60 seconds and use private/no-store response headers.
