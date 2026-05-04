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
