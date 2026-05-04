# SC2 Tools cloud setup — step-by-step

This guide walks you through everything needed to bring the SC2 Tools
cloud SaaS online from a fresh laptop. Follow it top to bottom and
you'll have, in roughly **60–90 minutes**:

1. A signed-in `https://your-domain.app/sign-in` page (Clerk + Google)
2. A live API at `https://your-api.onrender.com/v1/health`
3. A MongoDB Atlas cluster with backups + your indexes
4. A Vercel project hosting the Next.js frontend
5. A working agent on your gaming PC that auto-syncs replays

You don't need to be a developer. Read each step, follow it, paste
the values where the guide says to. If a step fails, the troubleshooting
section at the bottom tells you what went wrong.

---

## What you'll need before you start

- A GitHub account, with this repo (`ReSpOnSeSC2/sc2tools`) pushed up.
- A credit card for the paid tiers (you can start everything on free).
- A domain name. If you don't have one yet, see step 7. Total cost is
  about $14/year.
- 60–90 min of focused time.

---

## 1. MongoDB Atlas — your database

You already have a MongoDB Atlas cluster from `community-builds`. We'll
add a second database alongside it so the two apps can scale
independently.

1. Go to https://cloud.mongodb.com/ and sign in.
2. Open your existing project (the one hosting `community-builds`).
3. Click **Browse Collections** on the cluster.
4. Click **Create Database**:
   - Database name: `sc2tools_saas`
   - Collection name: `users` (just to bootstrap; the API auto-creates
     the rest on first boot).
5. Open **Network Access** in the left sidebar. Confirm `0.0.0.0/0` is
   allowed (or, more safely, add the egress IPs Render gives you on
   the Render service settings page after step 3).
6. Open **Database Access**. Either reuse the existing user you set up
   for community-builds, or create a new one with **Read and write to
   any database** for `sc2tools_saas` only. Save the password somewhere
   safe — you'll paste it into Render in step 3.
7. Open **Database** → **Connect** → **Drivers** → **Node.js**. Copy
   the SRV connection string. It looks like:

       mongodb+srv://USER:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority

   Replace `<password>` with the password from step 6. Keep this
   string. You'll need it twice: once locally, once on Render.

> Tip — to verify the cluster is reachable, install the `mongodb`
> Node package (`npm i -g mongodb`) and run `node -e "require('mongodb').MongoClient.connect('YOUR_URI').then(()=>console.log('ok')).catch(console.error)"`.

---

## 2. Clerk — Google sign-in (and Discord, if you want)

Clerk handles all the OAuth UI so you never touch a passwords table.

1. Go to https://dashboard.clerk.com/ → **Add application**.
   - Name: **SC2 Tools** (or whatever you want)
   - **Email + password**: ON (good fallback)
   - **Google**: ON (this is what your users will mostly use)
   - **Discord**: ON if you want streamers to sign in with their
     Discord identity. Optional.
2. Click **Create application**.
3. You're now on the application dashboard. **Copy these two keys:**
   - **Publishable Key** (starts with `pk_test_...` or `pk_live_...`)
   - **Secret Key** (starts with `sk_test_...` or `sk_live_...`)

   Keep them open in another tab.

4. Left sidebar → **Domains**. Add:
   - `http://localhost:3000` (for local dev)
   - Whatever your Vercel preview URL will be
     (e.g. `https://sc2tools.vercel.app` — see step 5)
   - Your custom domain if you have one (e.g. `https://sc2tools.app`)

5. Left sidebar → **User & Authentication** → **Social Connections** →
   **Google** → ensure it's enabled. Default config is fine. Production
   apps need to add your own Google OAuth credentials for unbranded UX
   (see step 2b below). Test mode works as-is.

### 2b. (Recommended for production) Bring your own Google OAuth credentials

By default, Clerk's Google sign-in shows "Sign in to {Clerk Project Name}".
Once you have your own domain, you'll want it to say "Sign in to SC2 Tools"
with your favicon. To do that:

1. Go to https://console.cloud.google.com/ → create a new project named
   "SC2 Tools".
2. **APIs & Services** → **OAuth consent screen** → External → fill
   the app name, your email, your domain, your privacy URL.
3. **APIs & Services** → **Credentials** → **Create Credentials** →
   **OAuth Client ID** → **Web application**:
   - Authorized redirect URIs:
     `https://<your-clerk-frontend-api>.clerk.accounts.dev/v1/oauth_callback`
     (Clerk shows the exact URL to paste in their Google connection page.)
4. Copy the Client ID and Client Secret.
5. Back in Clerk → **Social Connections** → **Google** → switch from
   "Use Clerk's credentials" to **Use custom credentials** → paste
   the Client ID + Secret.

### 2c. JWT template (optional but recommended)

Clerk lets you customize the JWT shape. The API doesn't require it, but
if you want the JWT to include your user's email or stable ID:

1. Sidebar → **JWT Templates** → **+ New template** → **Default**.
2. Name it `default`. The default claims (`sub` = userId) are exactly
   what `apps/api` expects.

---

## 3. Render — host the API

Render hosts the Express + MongoDB API.

1. Go to https://render.com/ → sign in (use the same email as MongoDB
   if convenient).
2. **New** → **Blueprint** → connect your GitHub account → pick the
   `ReSpOnSeSC2/sc2tools` repo.
3. Render reads `apps/api/render.yaml` and proposes one web service:
   `sc2tools-api`. Click **Apply**.
4. While it provisions (~3 minutes), open the service and go to
   **Environment** in the sidebar. Fill these:

   | Name                     | Value                                       |
   | ------------------------ | ------------------------------------------- |
   | `MONGODB_URI`            | Your full SRV string from step 1            |
   | `CLERK_SECRET_KEY`       | The `sk_test_...` or `sk_live_...` from step 2 |
   | `SERVER_PEPPER_HEX`      | Run `openssl rand -hex 32` in a terminal and paste the result. **Save this** — losing it means losing the ability to verify cross-user opponent dedupe hashes. |
   | `CORS_ALLOWED_ORIGINS`   | Comma-separated. Include `http://localhost:3000` and whatever Vercel URL you'll use. Edit again after step 5 once you know the prod URL. |

   Other vars (`NODE_ENV`, `MONGODB_DB`, `LOG_LEVEL`, `RATE_LIMIT_PER_MINUTE`)
   already have sane defaults from `render.yaml`.

5. Click **Save Changes**. Render redeploys with the new env vars
   (~2 min).
6. Open the service URL Render gave you (e.g.
   `https://sc2tools-api.onrender.com`). Test:

   ```bash
   curl https://sc2tools-api.onrender.com/v1/health
   # → {"status":"ok","time":"2026-..."}
   ```

   If you see `{"status":"ok"}`, the API is healthy and connected to
   Mongo. Save this URL — you'll need it for steps 5 and 7.

> **About cold starts**: the $7 Starter tier sleeps after 15 min of
> inactivity. The first request after a sleep takes ~30s. The agent
> retries automatically, so this is fine for early users; once you have
> a few active accounts, upgrade to Standard ($25/mo) which doesn't
> sleep.

---

## 4. Vercel — host the website

1. Go to https://vercel.com/ → **Add New** → **Project**.
2. Import `ReSpOnSeSC2/sc2tools`.
3. **Configure project**:
   - **Framework Preset**: Next.js (auto-detected)
   - **Root Directory**: click **Edit** and set to `apps/web`
   - **Build Command**: leave the default (`next build`)
   - **Install Command**: leave the default
4. **Environment Variables** — add these (from `apps/web/.env.example`):

   | Name                                | Value                                       |
   | ----------------------------------- | ------------------------------------------- |
   | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | The `pk_test_...` or `pk_live_...` from step 2 |
   | `CLERK_SECRET_KEY`                  | The `sk_test_...` or `sk_live_...` from step 2 |
   | `NEXT_PUBLIC_API_BASE`              | The Render URL from step 3                  |
   | `NEXT_PUBLIC_APP_NAME`              | `SC2 Tools` (or your branding)              |

   Apply to **Production**, **Preview**, and **Development**.

5. Click **Deploy**. Wait ~90 seconds.
6. When it's green, click the URL Vercel gives you
   (e.g. `https://sc2tools.vercel.app`). Sign in. You should land on
   `/app` and see "No games yet" — meaning auth, the API, and Mongo are
   all wired up.

7. **Add this URL back to Clerk** (step 2's Domains list) and
   **Render's `CORS_ALLOWED_ORIGINS`** (step 3) so prod requests
   aren't blocked. Both auto-redeploy on save.

---

## 5. Wire your custom domain (optional but recommended)

You can ship without this, but most users want
`https://sc2tools.app` instead of `sc2tools.vercel.app`.

1. Buy the domain. Recommended: `.app` because it's HTTPS-required
   by default. Google Domains, Namecheap, or Porkbun all sell `.app`
   for ~$14/year.
2. **Vercel** → **Project** → **Settings** → **Domains** → **Add** →
   `sc2tools.app` and `www.sc2tools.app`. Vercel shows DNS records.
   Apex (`sc2tools.app`) needs an A record pointing to Vercel's IP.
   `www` needs a CNAME pointing to `cname.vercel-dns.com`.
3. **Render** → **Service** → **Settings** → **Custom Domains** →
   **Add** → `api.sc2tools.app`. Render shows a CNAME to point to.
4. Update DNS at your registrar with the records from steps 2 and 3.
   Wait 1–10 minutes for propagation.
5. Update env vars in Vercel:
   - `NEXT_PUBLIC_API_BASE` → `https://api.sc2tools.app`
6. Update Render's `CORS_ALLOWED_ORIGINS` →
   `https://sc2tools.app,https://www.sc2tools.app` (comma-separated)
7. Update Clerk's allowed domains to include the custom domain.
8. Force-redeploy both Vercel and Render so the new env vars take
   effect.

---

## 6. Run the agent on your gaming PC

```powershell
# In PowerShell on your gaming PC, in the cloned repo root:
cd apps\agent
py -m pip install -r requirements.txt
copy .env.example .env
notepad .env
```

In `.env`, set:

```
SC2TOOLS_API_BASE=https://api.sc2tools.app
```

(Or whatever URL Render is hosting at if you skipped step 5.)

Then run:

```powershell
py -m sc2tools_agent
```

You'll see something like:

```
============================================================
  PAIRING CODE: 482917
  Open  https://sc2tools.app/devices  and enter this code.
============================================================
```

In your browser:

1. Go to `https://sc2tools.app/devices`
2. Enter the 6-digit code
3. Click **Pair device**

Within a few seconds the agent's tray icon flips to "Paired", and any
replay you finish in SC2 from this point on will appear at
`/app` within ~5s.

To start the agent automatically on boot:

1. Press <kbd>Win</kbd> + <kbd>R</kbd> → type `shell:startup` → Enter.
2. Right-click in that folder → **New** → **Shortcut**.
3. Target: `pythonw.exe -m sc2tools_agent` (use `pythonw`, not `python`,
   to avoid a console window).
4. Start in: `C:\SC2TOOLS\apps\agent` (or wherever the repo is).
5. Save.

---

## 7. (Optional) Wire the OBS overlay

Once you've played a few games:

1. Sign in at the website → **Streaming**.
2. Click **Create**. You get a URL like
   `https://sc2tools.app/overlay/abc123def456`.
3. Open OBS → **+** under Sources → **Browser** → **Create new**.
4. URL: paste it.
5. Width: 1920, Height: 1080.
6. Click OK. The overlay is invisible until your next game starts.

---

## Troubleshooting

**Agent shows pairing code, the `/devices` page rejects it.** The code
must be 6 digits, no spaces. Codes expire in 10 minutes — restart the
agent if yours has expired.

**`/v1/health` returns 500.** Render's logs (service → Logs) will tell
you why. 99% of the time it's `MONGODB_URI` mistyped or the cluster
firewall blocking Render's IP. Add `0.0.0.0/0` to Atlas's Network
Access while you debug, then narrow it.

**`/sign-in` says "Application is not configured for this domain".**
Add the URL to Clerk's allowed Domains list (step 2).

**Vercel build fails on `apps/web`.** Confirm the **Root Directory** is
exactly `apps/web` and that your monorepo's package-lock files are
committed.

**Opponents tab is empty after pairing.** The agent uploads on a slight
delay — ~30s after a game finishes for the deep parse. Open the
Render Logs while you play; you'll see `accepted: [{...}]` lines as
each game arrives.

**Cold start on first request after a long idle.** Expected on Render's
$7 Starter tier. Upgrade to Standard ($25/mo) when you're ready, or
add an UptimeRobot ping every 10 min to keep the dyno warm (free).

---

## What this gets you

After these 7 steps:

- **Anyone with a Google account** can sign in at your domain.
- **Their data** lives in your Atlas cluster, isolated per-user via
  the Clerk userId → internal userId mapping.
- **The agent** runs invisibly in the background on each user's PC,
  uploading every replay within seconds of finishing a game.
- **Your existing local install** (the `START_SC2_TOOLS.bat` flow)
  still works for users who don't want cloud — both paths use the
  same parsers, so feature parity is maintained.

Cost at this scale: ~$21/month total (Render $7 + MongoDB $9 free
tier upgrade + domain $14/yr). See `CLOUD_SAAS_ROADMAP.md` for the
breakdown by user count.

---

## Cross-references

- `apps/api/README.md` — full route reference
- `apps/web/README.md` — frontend dev notes
- `apps/agent/README.md` — agent architecture + packaging
- `CLOUD_SAAS_ROADMAP.md` — the multi-stage roadmap this is the
  Stage A + D + E + F + G slice of
