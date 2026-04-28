# sc2-community-builds

Shared community database for SC2 build definitions. Express + MongoDB.
Runs as a Render Web Service against a MongoDB Atlas free-tier cluster.

## Local development

```bash
cp .env.example .env
node scripts/generate-pepper.js   # paste into .env as SERVER_PEPPER_HEX
npm install
npm test                          # in-memory mongo, no setup needed
npm start                         # boots against MONGODB_URI from .env
```

## Endpoints

All routes are mounted at `/v1/community-builds`. See
`docs/community-builds-api.md` (in the repo root `docs/`) for full details.

## Required env vars

| Key                 | Notes                                              |
|---------------------|----------------------------------------------------|
| MONGODB_URI         | MongoDB Atlas connection string.                   |
| MONGODB_DB          | Database name. Defaults to `sc2_community_builds`. |
| SERVER_PEPPER_HEX   | 64 hex chars (32 bytes). Generate with the script. |
| PORT                | Defaults to 8080.                                  |
| LOG_LEVEL           | pino level. Defaults to `info`.                    |
| TRUST_PROXY         | Defaults to 1 for Render.                          |
| CORS_ALLOWED_ORIGINS| CSV. Empty allows all.                             |

## Deploying to Render

1. Create a MongoDB Atlas cluster (M0 free tier). Copy the SRV connection
   string and add an Atlas database user with `readWrite` on the target DB.
2. Generate a server pepper: `node scripts/generate-pepper.js`.
3. Push this directory to GitHub.
4. In Render, create a new Web Service from `render.yaml` (Blueprints).
5. Set the secret env vars (`MONGODB_URI`, `SERVER_PEPPER_HEX`, optionally
   `CORS_ALLOWED_ORIGINS`).
6. Wait for the first deploy. Health check is at
   `/v1/community-builds/health`.
