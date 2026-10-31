# SC2Tools — Cloud Deployment Guide

> **Production (October 2026):** the API runs on Render's **starter**
> plan, one instance (`apps/api/render.yaml`). The accepted database
> architecture is a dedicated Atlas M10 cluster with Cloud Backup
> ([ADR 0073](adr/0073-database-backups-atlas-cloud-backup.md)); the
> production API's public backup summary shows a readable Cloud Backup
> policy, and Admin → Infrastructure shows the live cluster tier. Check
> the tier there before relying on M10-only index or performance
> headroom. The `api-keepalive.yml` workflow exists solely to keep the
> starter instance awake. A July 2026 version of this note described a
> free-tier Atlas cluster, which has no Cloud Backup.

The keepalive workflow targets the Render API only. Do not add Vercel page
warmups to its five-minute schedule: those requests consume the website's
server execution allowance, and warming a separate endpoint does not ensure
the dashboard's function stays warm. The public status page checks website
reachability when a visitor opens it.

For Vercel usage, distinguish retained Deployment Storage (website outputs and
assets), Functions Storage (server-function packages) and Fluid Active CPU
(time spent executing server code). Review Usage by project and the same date
range. Vercel's free Hobby plan can restrict service after usage limits;
it does not automatically add paid overage. Consult the current
[Hobby rules](https://vercel.com/docs/plans/hobby) and
[storage optimization guide](https://vercel.com/docs/deployment-storage/optimize).
Review rollback requirements before deleting old deployments or shortening
retention. Reducing new output or traffic does not immediately erase prior
usage from the reporting window.

This guide walks you through wiring the three pieces of cloud infrastructure
together so the community-builds feature works end-to-end:

```
+------------------+        +-------------------+        +------------------+
|  Local SC2Tools  |  --->  |  Render (Express) |  --->  |  MongoDB Atlas   |
|  (your PC)       |        |  /v1/community... |        |  M10 cluster     |
+------------------+        +-------------------+        +------------------+
                                      ^
                                      |  (optional)
                            +-------------------+
                            |  Vercel (web UI)  |
                            +-------------------+
```

What you actually need:

- **Required:** MongoDB Atlas M10 + Render. That's the whole feature working.
- **Optional:** Vercel — only if you want the analyzer UI on a public URL
  separate from the existing Express backend.

---

## Part 1 — MongoDB Atlas M10

### 1.1 Provision the cluster

1. Go to <https://cloud.mongodb.com> and sign in.
2. **Create a new Project** named `sc2tools` (or reuse an existing one).
3. **Build a Database** → choose **M10** (Dedicated).
   - Provider: **AWS**, region: **us-west-2 (Oregon)** to match the Render
     region in `render.yaml` (lower latency).
   - Cluster name: `sc2-prod`.
4. Click **Create Cluster** and wait ~5 minutes.

### 1.2 Create a database user

1. Atlas left sidebar → **Database Access** → **Add New Database User**.
2. Authentication: **Password**.
3. Username: `sc2_app`.
4. Password: click **Autogenerate Secure Password**, then **Copy** —
   save it in your password manager. You will not see it again.
5. Built-in role: **Read and write to any database**.
6. Click **Add User**.

### 1.3 Allow Render to reach the cluster

1. Atlas left sidebar → **Network Access** → **Add IP Address**.
2. Two options:
   - **Easy / less secure:** Allow access from anywhere — `0.0.0.0/0`.
     Fine to start with; revisit later.
   - **Tighter:** Add Render's static outbound IPs after you've created the
     Render service (see Part 3.5). You'll come back to this step.
3. Click **Confirm**.

### 1.4 Grab the SRV connection string

1. Atlas → **Database** → click **Connect** on your `sc2-prod` cluster.
2. Choose **Drivers** → driver **Node.js**, version **6.7 or later**.
3. Copy the connection string. It looks like:
   ```
   mongodb+srv://sc2_app:<password>@sc2-prod.xxxxx.mongodb.net/?retryWrites=true&w=majority&appName=sc2-prod
   ```
4. **Replace `<password>`** with the password you saved in step 1.2.
5. Save the full string somewhere safe — you'll paste it into Render
   in Part 3 as the `MONGODB_URI` secret.

> **Sanity check:** the database the app uses defaults to `sc2_community_builds`.
> You don't need to create it manually — the server creates it on first write.

---

## Part 2 — Mint the server pepper

The "pepper" is a 32-byte secret the API mixes into HMAC signatures so
write requests can't be forged. You generate it once and treat it like a
password.

On your PC (PowerShell, in the repo root):

```powershell
cd C:\SC2TOOLS\cloud\community-builds
node scripts\generate-pepper.js
```

You'll see something like:

```
SERVER_PEPPER_HEX=8c4f...e1a7   # 64 hex characters
```

Copy the 64-character hex value. This becomes the `SERVER_PEPPER_HEX`
secret on Render in Part 3.

> **Do not** check the pepper into git. Do not paste it into chat. Treat
> it like a database password.

---

## Part 3 — Deploy the API to Render

Your repo already has `cloud/community-builds/render.yaml`, which is a
Render Blueprint. Render reads it and provisions the service for you —
you only need to fill in the two secrets.

### 3.1 Push the repo to GitHub

If you haven't already:

```powershell
cd C:\SC2TOOLS
git status                # confirm clean working tree
git push origin main
```

Render needs the repo to be on GitHub (or GitLab/Bitbucket) so it can pull.

### 3.2 Create the Render Blueprint

1. Go to <https://dashboard.render.com>.
2. Top-right → **New** → **Blueprint**.
3. Connect your GitHub account if you haven't, then select the
   `sc2tools` repo (or whatever yours is named).
4. Render scans the repo and finds `cloud/community-builds/render.yaml`.
5. **Branch:** `main`. Click **Apply**.
6. Render now creates the `sc2-community-builds` web service. It will
   fail to deploy on the first try — that's expected, because the secrets
   aren't set yet.

### 3.3 Set the secrets

1. Render dashboard → click into the `sc2-community-builds` service.
2. Left sidebar → **Environment**.
3. You'll see the env vars listed. The two with **(secret)** badges
   are blank. Fill them in:

   | Key                    | Value                                    |
   | ---------------------- | ---------------------------------------- |
   | `MONGODB_URI`          | the SRV string from Part 1.4             |
   | `SERVER_PEPPER_HEX`    | the 64-char hex from Part 2              |
   | `CORS_ALLOWED_ORIGINS` | see below                                |

4. **`CORS_ALLOWED_ORIGINS`** — comma-separated list of web origins
   allowed to call the API from a browser. Examples:
   - If you're only calling from the local Express backend on your PC:
     `http://localhost:3000`
   - If you also deploy the UI to Vercel later (Part 4):
     `https://sc2tools.vercel.app,http://localhost:3000`
5. Click **Save Changes**. Render will redeploy automatically.

### 3.4 Verify the deploy

Watch the **Logs** tab. You want to see:

```
listening on :8080
mongo connected db=sc2_community_builds
```

Then hit the health endpoint in your browser:

```
https://sc2-community-builds.onrender.com/v1/community-builds/health
```

(Use whatever hostname Render shows on your service page.)

Expected response:

```json
{ "ok": true, "db": "up", "uptimeSec": 12 }
```

If you get that, **the API is live and connected to Atlas**.

### 3.5 (Recommended) Lock down Atlas network access

Once Render is up, go back to Atlas → Network Access and:

1. Get Render's static outbound IPs from your Render service's
   **Connect** page (left sidebar → **Settings** → scroll to
   **Outbound IP Addresses**).
2. In Atlas Network Access, replace `0.0.0.0/0` with those specific
   IPs. Click **Confirm**.

---

## Part 4 — Vercel (optional)

You only need Vercel if you want the analyzer UI hosted on a public URL.
Skip this whole section if you're only running the desktop app locally
and reading from Render.

### 4.1 Decide what to deploy

Your repo has two web surfaces:

- `reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/` —
  the analyzer SPA (single HTML file, React via CDN). **This is the
  natural Vercel target.**
- `reveal-sc2-opponent-main/stream-overlay-backend/index.js` —
  the Express backend that currently serves the SPA. You don't need
  this on Vercel because the community-builds API is already on Render.

The clean split: **Render hosts the API, Vercel hosts the static UI.**

### 4.2 Deploy the analyzer SPA as a Vercel static site

1. Go to <https://vercel.com/new>.
2. **Import Git Repository** → pick the `sc2tools` repo.
3. **Configure Project**:
   - **Framework Preset:** Other.
   - **Root Directory:**
     `reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer`
   - **Build Command:** leave empty (it's static).
   - **Output Directory:** `.` (the same directory).
4. **Environment Variables:** none required for a pure static deploy.
5. Click **Deploy**.

After ~30 seconds you'll get a URL like
`https://sc2tools.vercel.app`.

### 4.3 Point the SPA at your Render API

The SPA needs to know where the community-builds API lives. Two options:

**Option A — hard-code the API base in the SPA.**
Open `reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/index.html`
and look for the API base URL (search for `/v1/community-builds` or
`API_BASE`). Set it to:

```js
const API_BASE = "https://sc2-community-builds.onrender.com";
```

Commit and push — Vercel auto-redeploys.

**Option B — use a Vercel rewrite.**
Add `vercel.json` next to `index.html` with:

```json
{
  "rewrites": [
    {
      "source": "/v1/community-builds/:path*",
      "destination": "https://sc2-community-builds.onrender.com/v1/community-builds/:path*"
    }
  ]
}
```

Then the SPA can keep using relative `/v1/community-builds/...` paths
and Vercel proxies them to Render. This keeps the API origin out of
the browser's CORS path.

### 4.4 Update CORS on Render

Whichever option you picked, go back to Render → Environment and make
sure `CORS_ALLOWED_ORIGINS` includes your Vercel URL:

```
https://sc2tools.vercel.app,http://localhost:3000
```

Save and let Render redeploy.

---

## Part 5 — Wire the local SC2Tools app to the cloud

So that the desktop app reads/writes community builds against your new
Render API instead of a local stub:

1. Open `C:\SC2TOOLS\reveal-sc2-opponent-main\stream-overlay-backend\.env`
   (create it if it doesn't exist).
2. Add:
   ```
   COMMUNITY_BUILDS_API=https://sc2-community-builds.onrender.com
   ```
3. Restart the local Express backend.
4. In the analyzer UI, perform a write that touches custom builds and
   confirm the request hits Render (check the Render **Logs** tab).

---

## Smoke-test checklist

Run through these, in order, after every redeploy:

- [ ] `GET https://<render-host>/v1/community-builds/health` → 200, `db: "up"`.
- [ ] Atlas → **Database** → **Browse Collections** shows the
      `sc2_community_builds` database created on first request.
- [ ] Render Logs are clean of `ECONNREFUSED` and `Authentication failed`.
- [ ] CORS preflight from your Vercel host succeeds (browser DevTools →
      Network → look for `OPTIONS` returning 204 with the
      `access-control-allow-origin` header echoing your origin).
- [ ] Local SC2Tools can read and write a build, and the change is
      visible from another machine after sync.

---

## Common errors and fixes

| Symptom                                    | Likely cause                              | Fix                                                          |
| ------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------ |
| Render deploy: `MongoServerError: bad auth`| Wrong password in `MONGODB_URI`           | Re-paste the SRV string with the correct password.           |
| Render deploy: `MongoNetworkError`         | Atlas IP allowlist excludes Render        | Atlas → Network Access → add Render's outbound IPs or 0/0.   |
| Render deploy: `SERVER_PEPPER_HEX invalid` | Pepper isn't 64 hex chars                 | Re-run `generate-pepper.js`, copy the *full* line.           |
| Browser console: `CORS blocked`            | `CORS_ALLOWED_ORIGINS` missing your origin| Add your Vercel/local URL to the env var on Render and save. |
| `/health` returns `db: "down"`             | Atlas user lacks read/write role          | Atlas → Database Access → grant `readWriteAnyDatabase`.      |

---

## What NOT to do

- Don't commit `MONGODB_URI` or `SERVER_PEPPER_HEX` to git.
- Don't lower Atlas to a free tier — the M10 sizing matters for the
  index strategy used by `cloud/community-builds`.
- Don't deploy the Express backend (`stream-overlay-backend`) to Vercel
  without converting it to serverless functions first. It expects a
  long-running Node process; Render handles that, Vercel does not by default.
- Don't put your character_id or account_id into any public repo or
  Vercel env var. Those stay in your local `profile.json`.

## Current app: optional Community cache revalidation

This section applies to `apps/api` and `apps/web`; the older cloud/SPA setup
above is separate. Source defaults do not enable a purge integration. No
production configuration is changed by the cache implementation.

If the owner later configures revalidation, set these values together:

| Runtime | Variable | Purpose |
| --- | --- | --- |
| API | `COMMUNITY_REVALIDATE_URL` | The web origin's `/api/revalidate-community` endpoint. |
| API and web | `COMMUNITY_REVALIDATE_SECRET` | The same private, independently generated shared secret in both runtimes. Never use a public-prefixed variable. |

The signed JSON body is `{ts,scope:"community"}` using the existing guides
raw-body HMAC header/protocol, with a separate scope and secret. The receiver
accepts a five-minute clock window, at most 4 KiB and two seconds of body
reading. It revalidates the `community` tag, the `/community`, `/players` and
`/p` layouts, and `/sitemap.xml`. The sender has a
five-second deadline, one active request and one coalesced pending notification;
it logs only a status or fixed error label. Unset API values make sending a
no-op. An unset web secret makes the receiver return 503. Configure both
runtimes before relying on purge delivery; a web-only secret cannot establish
working delivery.

Community pages are not cached even with configuration present. Since public
player pages (PR #758), their reads carry current publication capabilities that
a best-effort purge cannot keep fresh after a profile opt-out, so the web fetches
them with no revalidation and no tags (`apps/web/lib/communityCache.ts`; ADR
0074), and Community social cards render uncached. The API sends `no-store` on
decorated Community reads (the build list, build detail and arcade universe)
and on author profiles; only the content-only `/v1/community/sitemap` sends
`public, s-maxage=60, stale-while-revalidate=600`. Publish/update,
unpublish, moderation, rounded vote-score changes, admin edits and game
visibility/deletion/restore/GDPR changes notify the receiver. Unknown mutation
outcomes invalidate conservatively. Delivery is best effort, so the UI makes no
unconditional "within seconds" promise. A failed read uses the
unavailable/retry boundary; a confirmed missing resource takes the existing
not-found path.

Community's existing loading boundaries may already have streamed HTTP 200
when a child resource is found missing; Next then sends its 404 fallback and
noindex without the old content. Cache work preserves that behavior, not a raw
HTTP404 improvement. The API still answers strict 404/no-store on a missing,
removed or below-floor resource.

Since PR #758, decorated Community API reads and author profiles send
`no-store`, and only the content-only `/v1/community/sitemap` sends `public,
s-maxage=60, stale-while-revalidate=600`; owner/admin data, missing resources
and errors stay `private, no-store`. The web site-stats proxy uses 15/60 seconds on success and
no-store on errors, with an uncached upstream request.

Opponent data is the deliberate exception: API, data fetch and page rendering
always remain no-store, even with working purge. The planned six-hour render
window is unsafe when a failed purge could retain a removed profile or bypass
the five-owner privacy floor. A bounded one-hour, 128-entry service LRU reduces
materialization work, with a 64 KiB payload cap, two cold workers and current
removal/identity/floor admission on every request. Generation invalidation
rejects late fills. No extra endpoint, index or background corpus scan is
required. A CDN must preserve this no-store exception.

Validate configuration only against disposable local fixtures first: signed
scope/body rejection, publish and removal invalidation, configured failed-purge
opponent requests, public/private response headers and an upstream outage.
Never use a real account mutation merely to smoke-test purge delivery.
