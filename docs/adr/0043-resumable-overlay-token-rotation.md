# 0043: Resumable overlay token rotation

Date: 2026-10-25

Status: Accepted

## Context

Overlay credentials key live Studio state and engagement rows. Revoking a
leaked URL without moving those rows strands its XP, predictions and controls.
The API runs as one instance; ordinary chat ingest must not acquire renewing
Mongo leases or introduce infrastructure.

## Decision

- Reserve one replacement on the owned source row with a durable CAS. The
  destination starts hidden and cannot authenticate or accept mutations.
- Enrol Studio and engagement mutations in a bounded in-memory admission/drain
  gate before resolving the credential. Close admission before the CAS, clear
  cached and in-flight resolutions, retire old sockets and drain admitted work.
  Restart discards in-flight work; the durable marker rejects new admission.
- Copy the authoritative canonical-or-legacy Studio document, preserving b-roll
  anchors. Rekey four engagement collections with updateMany over at most500
  existing IDs per batch and8 batches per request. Select remaining source rows
  on retry, including after an ambiguous acknowledged write. Never delete data
  or create a second replacement to recover a failed step.
- Revoke the source before activating the destination. Resume incomplete
  activation on retry. Collapse only owned, ready replacement chains, bounded
  at32 source receipts and16 hops. A missing, revoked, cyclic or overlong target
  never becomes an active credential by retrying a former source.
- Keep all socket notices boolean-only: overlay sockets also join user rooms.
  Exact mappings travel through owner-authenticated configuration/heartbeat
  responses. Internal prediction/clip fanout isolates known unavailable-token
  admission errors; a healthy different token still receives its update.
- Switch an existing chat bot's exact token without reconnecting or enabling
  its provider. Preserve a pending-source marker across restoration/configure
  and fence held token-list responses with a bounded receipt buffer.
- Uploaded sound bytes are userId-owned; stored upload IDs and strict legacy
  sound paths are rendered through the current token's serve route. Alert media
  uses token-independent catalog object keys and short-lived grants. No R2
  object copy, provider publication or integration change is needed.
- Preserve current overlay credential/lifecycle rows during snapshot restore.
  Historical token sections remain readable for archive format compatibility,
  but cannot revive a leaked URL or erase its replacement.
- Native repair follows exact authenticated mappings within recognized generated
  scenes under existing OBS opt-in. It preserves source settings/query/geometry;
  custom sources and Dock URLs remain manual. Multi-token selection and rename
  stay owner-scoped, with bounded requests and explicit continuation of partial
  rotations.

## Consequences

No new collection, index, production migration, background job, provider call,
infrastructure or budget increase. A large or interrupted rotation pauses
safely and requires an owner retry. Deployment must retain the documented
single-API-instance topology for this in-memory drain guarantee. Rollback must
retain refusal of durable pending/replaced credentials until they are resumed;
an older build that ignores those markers is not a safe rollback target.
