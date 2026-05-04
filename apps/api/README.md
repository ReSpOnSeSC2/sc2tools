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

## Deploy

`render.yaml` provisions a Docker web service. Set the env vars
listed in `.env.example` from the Render dashboard. See
[`docs/cloud/SETUP_CLOUD.md`](../../docs/cloud/SETUP_CLOUD.md) for the
full step-by-step.

## Realtime

Socket.io is exposed at the same URL. Clients authenticate by passing
a Clerk JWT in `auth.token`, then call `subscribe:user` with their
internal userId. The server emits `games:changed` to the user's room
on every accepted game ingest.
