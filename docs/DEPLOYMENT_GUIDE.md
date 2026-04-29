# SC2Tools — Cloud Deployment Guide

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
