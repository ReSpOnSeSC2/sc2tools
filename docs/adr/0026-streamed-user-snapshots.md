# ADR 0026: Stream user snapshots and validate restores through temporary staging

- Status: accepted for implementation; production migration requires an explicit operator run
- Date: 2026-10-23

## Context

Embedding a full account export in one Mongo backup document fails at the 16 MiB document limit. Clearing every game-detail/replay object during restore destroys files even for game IDs that remain present. The shared database tier does not require replica-set transactions for these operations.

## Decision

Stream BSON Extended JSON NDJSON through gzip and bounded multipart uploads to the existing private R2 bucket. Keep only metadata in Mongo. Independent retention buckets retain five manual, two weekly automatic and three pre-action snapshots. Weekly creation is lazy at ingest, without a scheduled job or new infrastructure.

Before restore, validate identity, format, counts and SHA-256 while streaming rows into an owner/operation-scoped staging collection. TTL removes crash residue. Indexed membership supports a bounded-memory preview and difference scan. Restore keeps current heavy assets for the game-ID intersection; only current HEAD-verified replay markers are restored. A revision from the preview protects the web confirmation against games synced in between.

Use the existing exclusive GDPR fence for manual captures, restore, wipe and repair, and symmetric expiring user write leases for authenticated writes to covered data. Shared weekly-reader leases exclude destructive actions while allowing an import to continue. User writers never remove GDPR locks. Pre-action capture fails closed if backup storage is unavailable.

Ordinary preferences and editable profile fields restore through literal field updates. Account identity/roles, pairing credentials, onboarding progress/goals, notification preferences, work queues and shared/public content are not resurrected. New source fields must be deliberately classified before adding them to the restorable format.

## Consequences

The archive has no whole-account Mongo or RAM ceiling; individual records remain subject to Mongo's document limit. Staging temporarily uses database capacity and is cleaned on success/failure or TTL expiry. A restore remains a sequence of bounded writes rather than an all-or-nothing transaction: its pre-action snapshot is the recovery point if the process dies midway. Heavy files already deleted cannot be recreated by a slim-data snapshot.

Existing embedded snapshots require the dry-run-first migration script; original payloads remain until an R2 upload and metadata conversion succeed. Rollback must retain these objects and metadata, since the old embedded-only reader cannot consume the new format. The compatible forward restore path is preferred to reintroducing embedded payloads.
