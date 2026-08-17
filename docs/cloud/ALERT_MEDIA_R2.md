# SC2 3D alert media on R2

The rendered SC2 alert presets (Zealot Victory Dance, Archon Merge, MULE Money
Drop and the rest of the `-3d` ids) are produced offline by
`tools/sc2-alert-renders`. This document covers where that output is stored and
why it is not treated like the rest of the alert catalog.

## Why these assets are different

Every other preset in `apps/web/lib/multichat/alerts.ts` is code-native: the
renderer composes typography, emoji, gradients and CSS decorations, so the
preset costs nothing to ship and anyone may use it.

The 3D presets are not. They are rendered from locally exported StarCraft II
models (`.m3`) and textures (`.dds`), which are rights-controlled Blizzard
assets. Two rules follow from that, and both are enforced in code:

1. **The media never ships in the public build.** Anything under
   `apps/web/public/` is served unauthenticated, so putting the WebM/WebP there
   would make it world-readable no matter what the UI does.
   `apps/web/public/alerts/sc2-3d/.gitignore` keeps that directory empty of
   media on purpose.
2. **Only admin accounts may resolve it.** The presets carry
   `adminOnly: true`, `visiblePresetsFor()` hides them from the picker for
   non-admins, and the renderer falls back to the code-native static art when
   no presigned URL is available.

## Buckets

Both buckets are **private**. Neither has public access or a custom domain, and
neither should be given one.

| Bucket | Prefix | Contents |
| --- | --- | --- |
| `sc2tools-alert-renders` | `alert-renders/v1` | Full archive: every take, PNG frame sequence, `.dds` texture, `.m3` model, manifest and inspection report. ~2.9 GB. Never served to a browser. |
| `sc2tools-alert-media` | `alerts/sc2-3d` | Delivery set only: the approved WebM animations and their WebP posters. Presigned per request for admin sessions. |

`sc2tools-replays-prod` is unrelated and holds `game-details` and
`raw-replays/v1`. Keeping the render archive out of it avoids mixing
rights-controlled assets with user replay data, which has a different retention
and privacy profile.

Object keys in `sc2tools-alert-media` mirror the catalog paths exactly, so
`/alerts/sc2-3d/zealot-dance-3d.webm` in `alerts.ts` is the object
`alerts/sc2-3d/zealot-dance-3d.webm`. Keep them in lockstep: the catalog path
is the lookup key used against the presigned map.

## Uploading

`tools/sc2-alert-renders/upload_to_r2.py` reads credentials from the
environment or `apps/api/.env` and never prints them. It is resumable and
idempotent, comparing each object by size and by a SHA-256 stored in object
metadata, so re-running uploads nothing and an interrupted run resumes.

```bash
pip install boto3

# Dry run first — lists what would be sent, writes nothing.
python tools/sc2-alert-renders/upload_to_r2.py \
    --bucket sc2tools-alert-renders --prefix alert-renders/v1 --dry-run

# 1. Full archive (~2.9 GB, 6,470 objects)
python tools/sc2-alert-renders/upload_to_r2.py \
    --bucket sc2tools-alert-renders --prefix alert-renders/v1

# 2. Delivery set (22 objects)
python tools/sc2-alert-renders/upload_to_r2.py \
    --bucket sc2tools-alert-media --prefix alerts/sc2-3d \
    --source tools/sc2-alert-renders/output/production-authentic-approved-packaged
```

The uploader sets `video/webm` and `image/webp` content types and marks media
`Cache-Control: public, max-age=31536000, immutable`. That is safe despite the
`public` token because the objects are only ever reachable through a presigned
URL — the directive governs how a browser caches a response it already
fetched, not who may fetch it. Keys sit under a versioned prefix and never
change in place.

## Serving

The API mints short-lived presigned GET URLs, mirroring how
`apps/api/src/services/replayFiles.js` already serves private replay objects.
Bucket credentials stay server-side; the browser only ever sees a signed URL
with a short TTL.

The client seam is in place: `apps/web/lib/multichat/mediaBase.ts` holds the
grant store, `resolveAlertMediaUrl()` maps a catalog path onto a presigned URL,
and `ChatAlertCard` subscribes to the store and falls back to static art on a
miss. Until an admin session populates a grant, every lookup misses and the 3D
presets render their code-native fallback — which is the correct behaviour for
a non-admin viewer.

### Endpoints

Two surfaces need the media, and they carry different credentials:

| Endpoint | Credential | Gate |
| --- | --- | --- |
| `GET /v1/multichat/alert-media` | Clerk session | `deps.isAdmin(req)` |
| `GET /v1/multichat/:token/alert-media` | overlay URL token | owning user's persisted `role: "admin"` |

The overlay route cannot reuse the Clerk gate. Overlay tokens are created with
the internal user UUID (`auth.userId`) and never see a Clerk session, so there
is no Clerk id to compare against `SC2TOOLS_ADMIN_USER_IDS`. It calls
`users.isAdminUserId()`, which reads the persisted role and therefore also
covers admins minted by the email allowlist or an explicit grant.

Both return `403 { error: { code: "admin_only" } }` otherwise, `503
alert_media_not_configured` when R2 is unset, and `Cache-Control: private,
no-store` so a signed URL is never held by a shared cache.

Response shape, consumed by `toAlertMediaGrant()`:

```json
{ "urls": { "/alerts/sc2-3d/zealot-dance-3d.webm": "https://..." }, "expiresIn": 300 }
```

`alertMediaStore.js` lists the delivery prefix and presigns each object,
caching the listing for 60s and coalescing concurrent requests. Neither the
catalog nor the bucket keeps a hardcoded file list, so publishing a new render
batch needs no code change.

On the client, `useOverlayAlertMediaGrant(token)` drives the overlay and the
Settings panel fetches through `useApi` (which attaches the Clerk JWT), both
publishing to the grant store in `mediaBase.ts`. A 403 or 503 leaves the grant
empty and stops polling, so non-admins settle on the static fallback.

### Production configuration

```
R2_ALERT_MEDIA_BUCKET=sc2tools-alert-media
R2_ALERT_MEDIA_PREFIX=alerts/sc2-3d
R2_ALERT_MEDIA_EXPIRES_SEC=300
R2_ALERT_MEDIA_ACCESS_KEY_ID=<Object Read only token>
R2_ALERT_MEDIA_SECRET_ACCESS_KEY=<its secret>
```

Give the deployed API an **Object Read only** token scoped to
`sc2tools-alert-media` alone. It signs GETs and never writes, so write access
would be surplus reach. The dedicated pair is required because R2 tokens are
bucket-scoped: the replay-store credentials cannot read this bucket. Both
halves must be set; a half-set pair is ignored in favour of the shared
credentials rather than silently signing with the wrong key.

Leaving `R2_ALERT_MEDIA_BUCKET` unset disables the feature cleanly — the
endpoints answer 503 and the 3D presets render their code-native art. Every
other preset in the catalog is code-native and unaffected.
