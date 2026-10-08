# 0024: Paired YouTube sessions and optional stream controls

Date: 2026-10-08

Status: Accepted for the Stream Studio preview

## Context

OBS sends video to reusable YouTube stream keys, while each completed YouTube
broadcast has its own lifecycle. Starting those inputs again is insufficient to
reliably create a fresh horizontal and vertical broadcast without Studio. Titles
also need to be applied to the correct connected accounts. The desktop replay
pipeline and scene switcher must remain independent of these provider requests.

## Decision

The agent prepares two independent broadcasts on explicitly selected reusable
stream IDs. Both must be bound and their metadata verified before they show
Ready. The vertical description links to its current horizontal partner. OBS and
Aitum continue to start and stop the video outputs; TikTok LIVE Studio receives
the horizontal OBS virtual camera and retains its own title and Go LIVE controls.

The ordinary connection uses the paired SC2Tools account and the existing server
OAuth applications. Stream controls require explicit additional consent. Provider
tokens remain encrypted in the server vault; the desktop receives bounded
operation results rather than provider secrets. Advanced user-owned OAuth
configuration remains optional and uses Windows per-user encryption locally.

Every YouTube creation has a durable UUID written locally before transmission.
The server persists a per-user operation ledger before calling the provider,
uses atomic ownership and credential leases, and retains uncertain outcomes.
Recovery reads the original operation; it never blindly repeats a provider POST.
Creation UUIDs are retained until SC2Tools account/data deletion. Daily quota
counters alone expire automatically. Disconnecting a provider removes its grant
and keeps operation history; replay-history deletion also keeps that history.

Automatic preparation creates another pair only after both owned broadcasts are
terminal and both observed OBS inputs are stopped. Missing observations, active
keys, unfinished metadata, uncertain creation, authorization failures, and quota
limits block progression. Polling has bounded deadlines and persisted backoff.
Streaming work uses a separate worker and OBS client from the scene switcher.

## Consequences

Sign-in-once operation does not require users to register developer applications.
Google verification and sufficient shared YouTube API quota remain prerequisites
for broad public rollout. TikTok's native partner integration is not provided by
the public APIs used here. The UI and public showcase identify this release as a
preview until installation and actual provider-session checks are complete.

The database change is additive and needs no backfill. Rollback may restore the
previous application deployment, but must retain the operation ledger and
encrypted vault records so a later upgrade cannot repeat uncertain creations.
Provider broadcasts already created survive rollback. Local installation keeps
the existing agent state and OBS configuration; a pre-upgrade backup supports
restoring the previous executable and settings together if necessary.

## Validation

Focused desktop tests cover paired lifecycles, recovery, output observation,
metadata verification, provider title readback, encryption, GUI state, and
scene-switcher isolation. API tests exercise device authorization, explicit
scope upgrades, ownership, atomic Mongo reservations, uncertain outcomes, quota
counters, and credential fencing. Required repository CI runs the complete API,
web, agent, engine, browser parity, and responsive public-page checks.

Provider consent and bounded live sessions are separate acceptance checks; unit
tests and a successful installer build do not establish live-stream readiness.
