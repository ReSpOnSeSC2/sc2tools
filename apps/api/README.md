# @sc2tools/api — cloud API

Express + MongoDB + Clerk JWT, hosted on Render.

## Local dev

```bash
cd apps/api
npm install
cp .env.example .env
# Fill MONGODB_URI, CLERK_SECRET_KEY, SERVER_PEPPER_HEX (openssl rand -hex 32)
npm run dev
curl http://localhost:8080/v1/health
```

## Routes

All routes are mounted under `/v1`.

| Method | Path                              | Auth         | Purpose                       |
| ------ | --------------------------------- | ------------ | ----------------------------- |
| GET    | /v1/health                        | none         | DB ping for Render            |
| GET    | /v1/me                            | clerk/device | Current user + game stats     |
| GET    | /v1/opponents                     | clerk/device | Page through opponents        |
| GET    | /v1/opponents/:pulseId            | clerk/device | One opponent + aggregates     |
| GET    | /v1/games                         | clerk/device | Page through games            |
| GET    | /v1/games/:gameId                 | clerk/device | One game's full record        |
| POST   | /v1/games                         | clerk/device | Ingest from agent (1 or batch) |
| GET    | /v1/custom-builds                 | clerk        | List user builds              |
| GET    | /v1/custom-builds/:slug           | clerk        | One build                     |
| PUT    | /v1/custom-builds/:slug           | clerk        | Upsert                        |
| DELETE | /v1/custom-builds/:slug           | clerk        | Soft delete                   |
| POST   | /v1/device-pairings/start         | none         | Agent: start pairing          |
| GET    | /v1/device-pairings/:code         | none         | Agent: poll                   |
| POST   | /v1/device-pairings/claim         | clerk        | Web: bind code to user        |
| GET    | /v1/devices                       | clerk        | List paired devices           |
| DELETE | /v1/devices/:tokenHash            | clerk        | Revoke a device                |
| GET    | /v1/overlay-tokens                | clerk        | List overlay tokens           |
| POST   | /v1/overlay-tokens                | clerk        | Create one                    |
| DELETE | /v1/overlay-tokens/:token         | clerk        | Revoke                        |

### Analytics surface (Stage C bucket 1)

| Method | Path                              | Auth         | Purpose                       |
| ------ | --------------------------------- | ------------ | ----------------------------- |
| GET    | /v1/summary                       | clerk/device | Totals, byMatchup, byMap, recent |
| GET    | /v1/matchups                      | clerk/device | vs P/T/Z/R/Unknown            |
| GET    | /v1/maps                          | clerk/device | Per-map W/L                   |
| GET    | /v1/build-vs-strategy             | clerk/device | (myBuild × opp.strategy) cross-tab |
| GET    | /v1/random-summary                | clerk/device | Random-race tracker           |
| GET    | /v1/timeseries                    | clerk/device | Daily/weekly/monthly W-L      |
| GET    | /v1/mmr-by-matchup                | clerk/device | Verified net MMR by opponent race |
| GET    | /v1/mmr-by-matchup/opponents      | clerk/device | Filterable opponent MMR-impact drilldown |
| GET    | /v1/games-list                    | clerk/device | Map Intel selector            |
| GET    | /v1/builds                        | clerk/device | Builds ranked by frequency    |
| GET    | /v1/builds/:name                  | clerk/device | Drilldown                     |
| GET    | /v1/opp-strategies                | clerk/device | Detected opponent strategies  |
| GET    | /v1/catalog                       | clerk/device | sc2_catalog.json              |
| GET    | /v1/definitions                   | clerk/device | timing_catalog.json           |
| GET    | /v1/export.csv                    | clerk/device | Per-user CSV stream           |
| GET    | /v1/map-image?map=…               | clerk/device | Map JPG (proxied)             |
| GET    | /v1/playback                      | clerk/device | 501 — local-only stub         |

### Per-game compute (Stage C bucket 2)

| Method | Path                                         | Auth         | Purpose                       |
| ------ | -------------------------------------------- | ------------ | ----------------------------- |
| GET    | /v1/games/:gameId/build-order                | clerk/device | Parse stored buildLog         |
| GET    | /v1/games/:gameId/apm-curve                  | clerk/device | Read stored apmCurve          |
| POST   | /v1/games/:gameId/apm-curve                  | device       | Agent uploads recomputed APM  |
| GET    | /v1/games/:gameId/macro-breakdown            | clerk/device | Read stored breakdown         |
| POST   | /v1/games/:gameId/macro-breakdown            | clerk/device | Persist or request recompute  |
| POST   | /v1/games/:gameId/opp-build-order            | device       | Agent uploads opp build log   |
| POST   | /v1/games/:gameId/replay-upload              | device       | Prepare signed pending PUT    |
| POST   | /v1/games/:gameId/replay-upload/complete     | device       | Verify and promote replay     |
| GET    | /v1/games/:gameId/replay-download            | clerk/device | Prepare signed private GET    |
| POST   | /v1/macro/backfill/start                     | clerk        | Kick a per-user macro pass    |
| GET    | /v1/macro/backfill/status                    | clerk/device | Job state                     |
| POST   | /v1/macro/backfill/progress                  | device       | Agent reports per-game result |

### Bulk import (Stage C bucket 3)

| Method | Path                              | Auth         | Purpose                          |
| ------ | --------------------------------- | ------------ | -------------------------------- |
| POST   | /v1/import/scan                   | clerk        | Ask agent to count candidates    |
| POST   | /v1/import/start                  | clerk        | Ask agent to bulk-import         |
| POST   | /v1/import/cancel                 | clerk        | Abort a running import           |
| GET    | /v1/import/status                 | clerk/device | Latest job state                 |
| GET    | /v1/import/jobs                   | clerk        | History (most recent N)          |
| GET    | /v1/import/cores                  | clerk/device | Agent-reported CPU cores         |
| POST   | /v1/import/host-info              | device       | Agent reports cores + folders    |
| POST   | /v1/import/progress               | device       | Agent reports per-replay result  |
| POST   | /v1/import/extract-identities     | clerk        | Ask agent for identity dump      |
| POST   | /v1/import/pick-folder            | clerk        | Ask agent to show folder picker  |

### Coaching practice assignments

These routes are invisible to accounts outside the Coaching Locker roster.
Assignment progress is calculated from stored replays on every read; clients
never submit counters or game associations. A roster link is not consent:
practice assignments, performance, build suggestions, and replay evidence
remain unavailable until the exact linked student account accepts sharing with
the exact linked coach account. Revocation is checked again on every
coach-facing read; the student retains their own plan history.

`DELETE /v1/me` erases assignment rows involving the account, removes its
bookings and coaching identity, severs consent relationships, removes any
coach-owned calendar, and garbage-collects Locker media referenced only by the
deleted student's record. Other students' coaching work and shared media are
preserved.

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| GET | /v1/coaching/practice-sharing | clerk coaching role | Read the live consent state visible to the caller |
| POST | /v1/coaching/students/:studentId/practice-sharing/request | clerk coach/admin | Request or re-request student consent using Locker revision CAS |
| POST | /v1/coaching/practice-sharing/respond | clerk student | Accept or reject the current pending relationship |
| POST | /v1/coaching/practice-sharing/revoke | clerk student | Immediately revoke an accepted relationship |
| GET | /v1/coaching/assignments | clerk coaching role | Page scoped assignments (`page`, `limit`) with live recurrence progress |
| POST | /v1/coaching/students/:studentId/assignments | clerk coach/admin | Create an idempotent build or total-game requirement |
| PUT | /v1/coaching/assignments/:assignmentId | clerk coach/admin | CAS-cancel an immutable requirement |
| GET | /v1/coaching/assignments/:assignmentId/games | clerk coaching role | Page qualifying replay evidence on demand |
| GET | /v1/coaching/assignments/:assignmentId/games/:gameId/replay-download | clerk coaching role | Authorize and sign a qualifying student's original replay |
| GET | /v1/coaching/students/:studentId/performance | clerk coaching role | Read consent-gated ranked 1v1 performance |
| GET | /v1/coaching/students/:userId/games | clerk coaching role | Read consent-gated 1v1 build suggestions |

Create/update definitions use inclusive local `startsOn` and `endsOn` dates
(`YYYY-MM-DD`) plus an IANA `timeZone`. Responses also include the resolved
UTC `startsAt` (inclusive) and `endsAt` (exclusive) instants. Eligible games
are non-resumed 1v1 replays, whether ladder or custom; team and FFA games are
always excluded. Eligibility and recurring-calendar attribution use the replay
start instant. Older rows without `startedAt` derive it from `date - durationSec`
and fall back to `date` only when neither source is available.

### Spatial heatmaps (Stage C bucket 5)

| Method | Path                                        | Purpose                                |
| ------ | ------------------------------------------- | -------------------------------------- |
| GET    | /v1/spatial/maps                            | List maps with spatial data            |
| GET    | /v1/spatial/buildings?map=…                 | Building-placement KDE                 |
| GET    | /v1/spatial/proxy?map=…                     | User's proxy heatmap                   |
| GET    | /v1/spatial/battle?map=…                    | Battle-location KDE                    |
| GET    | /v1/spatial/death-zone?map=…                | Where the user's army died             |
| GET    | /v1/spatial/opponent-proxies?map=…          | Where opponents proxied                |

### ML (Stage C bucket 4)

| Method | Path                                | Auth   | Purpose                          |
| ------ | ----------------------------------- | ------ | -------------------------------- |
| GET    | /v1/ml/status                       | clerk  | Model + last training job        |
| POST   | /v1/ml/train                        | clerk  | Kick async training              |
| GET    | /v1/ml/predict?…                    | clerk  | In-game opener prediction        |
| GET    | /v1/ml/pregame?…                    | clerk  | Pre-game opener probabilities    |
| GET    | /v1/ml/options                      | clerk  | Races + openings model knows     |

### Agent release feed (Stage D)

| Method | Path                                | Auth         | Purpose                          |
| ------ | ----------------------------------- | ------------ | -------------------------------- |
| GET    | /v1/agent/version                   | none         | Agent polls for new installer    |
| GET    | /v1/agent/releases                  | none         | Release history                  |
| POST   | /v1/agent/releases                  | admin token  | Publish a new release            |

### Infrastructure monitoring

| Method | Path                              | Auth  | Purpose                              |
| ------ | --------------------------------- | ----- | ------------------------------------ |
| GET    | /v1/public/infrastructure-costs   | none  | Aggregate public cost transparency   |
| GET    | /v1/admin/infrastructure          | admin | Provider usage + capacity advisories |
| GET    | /v1/admin/health                  | admin | Provider/configuration health        |

The admin infrastructure response uses three compact states: `healthy`,
`watch`, and `upgrade`. Capacity advisories use sustained Render and Atlas
compute signals, worst-case metrics across the Atlas electable nodes that were
successfully measured, and Atlas disk use. Disk pressure produces a
storage-specific action; tier-up advice requires sustained compute pressure.
A single five-minute spike and a full WiredTiger cache do not independently
recommend an upgrade. The endpoint
is `private, no-store` and returns a strict allowlist; provider credentials,
account/project/service IDs, bucket and cluster names, hostnames, and URLs are
never returned.

Optional provider settings are documented in `.env.example`:

- Cloudflare Account Analytics reads the configured bucket's R2 storage and
  operations. Its amount is an estimate: storage uses the provider's daily
  peak and Cloudflare applies free allowances account-wide.
- Atlas uses a service account with Project Read Only and Organization Billing
  Viewer. Billing is a pending-cycle projection, not a completed invoice.
- Render uses `RENDER_API_KEY`; Render injects `RENDER_SERVICE_ID`
  automatically. Render API keys are broadly account-scoped, not metrics-only,
  so this integration is optional, server-only, GET-only in this application,
  and must never be copied into the web app. Render has no invoice value in
  this API, so `RENDER_MONTHLY_COST_USD` is an optional operator-maintained
  planning amount.

Advisories are prominent in-admin notifications generated when the page is
loaded. They are not email or background alerts. Durable alert history and
email delivery require a separate scheduled-monitoring integration.

## Deploy

`render.yaml` provisions a Docker web service. Set the env vars
listed in `.env.example` from the Render dashboard. See
[`docs/cloud/SETUP_CLOUD.md`](../../docs/cloud/SETUP_CLOUD.md) for the
full step-by-step.

### Enable R2 with a full agent resync

The current rollout does not require a Mongo-to-R2 migration. MongoDB keeps
the slim, searchable game rows; R2 stores gzip-compressed detail objects and
the private original replay files. With the current small user base, rebuild
R2 from each user's local replay directory:

1. Create a private R2 bucket and a bucket-scoped Object Read & Write token.
2. Build and publish **agent 0.15.16** (`agent-v0.15.16`) with its checksum,
   select it as the latest stable release, and confirm `/download` serves that
   installer. Do this before enabling the dashboard warning so “Update agent”
   never sends a user back to 0.15.15.
3. Add the `R2_*` values from `.env.example` to Render, set
   `GAME_DETAILS_STORE=r2` and `REPLAY_FILES_STORE=r2`, and deploy the API.
4. Update every desktop installation to the latest agent version.
5. Have each user select **All time** and run **Re-sync replay library**.
   The agent re-reads the local `.SC2Replay` files, regenerates the R2 detail
   objects, and uploads the original replay binaries through short-lived
   signed URLs. On the Starter API, stagger the current users a few at a time
   so their parsing/metadata requests do not arrive in one burst.
6. Confirm Admin Health reports the R2 detail backend, then open several
   replay-detail views and download several originals before treating the
   rollout as complete.

The scripts under `src/db/migrations/2026-05-0*-*.js` remain optional recovery
tools for detail rows whose source replay is no longer available locally; they
are not part of the normal rollout. Mongo detail data cannot reconstruct an
original `.SC2Replay`, so only an All-time Re-sync from the source file can
backfill the downloadable archive. Do not run the heavy-field cleanup
migration until the R2 objects have been verified.

### Original replay files

With `REPLAY_FILES_STORE=r2` and the `R2_*` credentials configured, original
`.SC2Replay` files share the same private bucket under `R2_REPLAY_PREFIX` (default
`raw-replays/v1`). The desktop agent receives a five-minute, object-scoped
pending upload URL and sends the file directly to R2. R2 validates the signed
Content-MD5 against the uploaded bytes. Completion checks the stored size,
client identity SHA-256 metadata, and MPQ replay header, then server-side
copies the pending object to its permanent key and deletes the pending copy.
Web downloads receive a one-minute, object-scoped URL. Never make the bucket
public or ship R2 credentials to the agent or browser.

Add an [R2 lifecycle rule](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
that expires objects under
`raw-replays/v1-pending/` after one day (replace `raw-replays/v1` if
`R2_REPLAY_PREFIX` is customized). The API deletes pending objects during
normal completion and account/history cleanup; the lifecycle rule is the
safety net for abandoned URLs, crashed agents, and superseded upload nonces.

The authenticated endpoints are:

- `POST /v1/games/:gameId/replay-upload` (paired device only)
- `POST /v1/games/:gameId/replay-upload/complete` (paired device only)
- `GET /v1/games/:gameId/replay-download` (owning user)

Upload preparation accepts `{ filename, sizeBytes, sha256, md5 }`, where
`md5` is the standard base64 encoding of the 16-byte digest. It returns a
signed PUT plus `uploadId`, or `{ alreadyStored: true, replayAvailable: true }`
when an All-time Re-sync finds the same verified object. Completion accepts
`{ uploadId }`. Files are limited to 5 MB and must use the `.SC2Replay`
extension. Account deletion and full or date-ranged history wipes remove
both permanent and pending R2 objects before their Mongo ownership rows.

## Realtime

Socket.io is exposed at the same URL. Clients authenticate by passing
a Clerk JWT in `auth.token`, then call `subscribe:user` with their
internal userId. The server emits `games:changed` to the user's room
on every accepted game ingest.
