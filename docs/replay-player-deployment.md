# Replay player — deployment runbook

Everything needed to take the new replay player from "committed" to "running in
production as designed."

**Verified facts this runbook is built on** (checked against your account and repo,
not assumed):

| | |
|---|---|
| Cloudflare account ID | `ac486391f44e2d2b444c35d22ace7c77` |
| R2 S3 endpoint | `https://ac486391f44e2d2b444c35d22ace7c77.r2.cloudflarestorage.com` |
| Buckets | `sc2tools-sprites` (empty), `sc2tools-audio` (5 objects, see step 5) |
| Domains in Cloudflare | **none** — so R2 custom domains are not available yet (see step 6b) |
| Web host | Vercel (`README.md` → "deployed on Vercel") |
| Assets are gitignored | `apps/web/public/sprites/`, `apps/web/public/audio/replay/` |

---

## Step 0 — Local dev already works. Do this first.

You do **not** need Cloudflare to see the player. The assets are sitting in
`apps/web/public/` on your machine right now, and both base-URL env vars default
to those local paths.

```bash
cd apps/web
npm run dev
# open http://localhost:3000/app/game/<any gameId that has map playback>
```

**Do this before touching Cloudflare.** If something is wrong with the renderer,
you want to find out here — not after an hour of infra work. What to look for:

- units are 3D sprites, not flat icons (if they're icons, the sprite fetch failed
  — check the Network tab for 404s under `/sprites/`)
- units glide between waypoints and turn to face their direction of travel
- a Thor is visibly ~6× a Marine; a Hatchery dwarfs a Zergling
- terrain is full-colour, not dimmed
- pressing Play starts music after ~2s of fade-in

Known unknown: **I have never rendered this in a browser.** Everything is verified
by typecheck, 124 vitest tests and 39k harness assertions, but not by eye. Step 0
is where reality gets a vote.

---

## Step 1 — Push the commit

The commit is made and sitting on `main`. I couldn't push it: the sandbox that
reaches your repo has no network (`HTTP 403 from proxy after CONNECT`).

```bash
cd C:\SC2TOOLS
git log --oneline -1     # f8a4ec41 feat(replay): 3D sprite replay player, ...
git push origin main
```

> **If git complains about `index.lock` or `HEAD.lock`:** that's a leftover from my
> session — the Linux VM I work through isn't permitted to unlink files under the
> mount, so git couldn't clean up its own lock files. They're harmless. Delete
> `.git/index.lock` / `.git/HEAD.lock` and retry. I also parked several `tmp/lk-*.bak`
> files and `tmp/harness-scaffolding/` — all safe to delete, all inside gitignored `tmp/`.

---

## Step 2 — Create an R2 API token

You need this for the upload script. **Your existing replay-store R2 token will
not work** — R2 tokens are bucket-scoped, and it has no access to the two new
buckets.

1. Cloudflare dashboard → **R2 Object Storage** → **API** (top right) →
   **Manage API tokens** → **Create API token**
2. Token name: `sc2tools-assets-rw`
3. Permissions: **Object Read & Write**
4. Specify buckets: `sc2tools-sprites` **and** `sc2tools-audio`
5. TTL: whatever you're comfortable with
6. **Create**, then copy the three values it shows once:
   - Access Key ID
   - Secret Access Key
   - the S3 endpoint (should match the account ID above)

Put them in `apps/api/.env` (which is gitignored). The upload script reads these
names specifically, falling back to the shared `R2_*` pair if the sprite-specific
ones are absent:

```ini
R2_ENDPOINT=https://ac486391f44e2d2b444c35d22ace7c77.r2.cloudflarestorage.com
R2_SPRITE_ACCESS_KEY_ID=<Access Key ID>
R2_SPRITE_SECRET_ACCESS_KEY=<Secret Access Key>
```

These are only ever read locally by the upload script. Nothing at runtime needs
them — the browser fetches assets from a public URL.

---

## Step 3 — Upload the sprites (155 MB, 370 files)

```bash
cd C:\SC2TOOLS
node scripts/upload-sprites.mjs --dry-run          # confirm the file list first
node scripts/upload-sprites.mjs                    # real upload
```

Defaults: source `apps/web/public/sprites`, bucket `sc2tools-sprites`, prefix
`sprites/v1`. Objects land at `sprites/v1/{units,buildings}/<Race>/<Name>_<color>.webp`
with `Cache-Control: public, max-age=31536000, immutable`, 8 at a time. It skips
anything already present, so it's safe to re-run.

Expect a few minutes on a normal connection.

---

## Step 4 — Upload the audio (13 MB, 5 files)

```bash
node scripts/upload-sprites.mjs \
  --source apps/web/public/audio/replay \
  --bucket sc2tools-audio \
  --prefix audio/v1
```

---

## Step 5 — Clean up two stray objects (optional, cosmetic)

`sc2tools-audio` currently has 5 objects I uploaded by hand through the dashboard:
three at the bucket root, and two under a `protoss/` prefix. That split exists
only because the dashboard's file picker is reachable only from an *empty* folder
view, so I had to create a folder to upload the last two.

Step 4 writes clean copies under `audio/v1/`, and the code reads only from there —
so the five strays are dead weight, not a problem. Delete them from the dashboard
if you want a tidy bucket:

- `terran-iron-front-protocol.mp3`, `zerg-chitin-rift.mp3`, `zerg-chitin-rift-sting.mp3` (root)
- `protoss/protoss-orbital-reliquary.mp3`, `protoss/protoss-orbital-reliquary-ii.mp3`

---

## Step 6 — Make the buckets publicly readable

The browser fetches these directly, so the buckets need public read access.

### 6a — r2.dev (do this now)

For **each** of `sc2tools-sprites` and `sc2tools-audio`:

1. Bucket → **Settings** → **Public access** → **R2.dev subdomain** → **Allow Access**
2. Type `allow` to confirm
3. Copy the resulting URL — it looks like `https://pub-<32 hex chars>.r2.dev`

You'll get a **different** `pub-*` hostname per bucket. Note both.

> ⚠️ Cloudflare rate-limits `r2.dev` and explicitly does not recommend it for
> production traffic. It is fine for getting this running and for moderate use.
> See 6b for the real fix.

### 6b — Custom domain (the production answer, later)

Your Cloudflare account currently has **zero domains**, so this isn't available
today. To get it: add `sc2tools.com` (or `.app`) to Cloudflare and point its
nameservers there, then per bucket → **Settings → Custom Domains → Connect Domain**
→ `cdn.sc2tools.com`. That gives you real CDN caching, no rate limit, and a
stable URL. Swapping to it later is a one-line env change — nothing in the code
knows the difference.

---

## Step 7 — Add a CORS policy to both buckets

**This step is not optional and it is the one most likely to bite you.** The code
sets `crossOrigin = "anonymous"` in three places — sprite sheets, the terrain
image, and the audio element — because all three are drawn into a canvas or routed
through Web Audio.

What breaks without it:

| asset | failure mode |
|---|---|
| sprite sheets | sheets fail to load → **every unit silently falls back to a flat icon** |
| audio | `createMediaElementSource` throws → music degrades to flat volume, **no battle swell** |
| terrain | canvas becomes tainted, blocking any future screenshot/clip export |

For **each** bucket: **Settings** → **CORS policy** → **Add CORS policy**, and paste:

```json
[
  {
    "AllowedOrigins": [
      "https://sc2tools.app",
      "https://sc2tools.com",
      "http://localhost:3000"
    ],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Length", "Content-Type"],
    "MaxAgeSeconds": 86400
  }
]
```

Trim `AllowedOrigins` to whichever of those is actually your production origin —
your API's `CORS_ALLOWED_ORIGINS` currently lists `https://sc2tools.app`, while
`NEXT_PUBLIC_SITE_URL` defaults to `https://sc2tools.com`. Use the real one, and
keep `http://localhost:3000` so local dev can point at R2 too.

---

## Step 8 — Set the environment variables

### Local (`apps/web/.env.local`)

Leave these unset for local dev and it serves from `public/` — that's the point of
the defaults. Only set them if you want to test against R2:

```ini
NEXT_PUBLIC_SPRITE_BASE=https://pub-<sprites hash>.r2.dev/sprites/v1
NEXT_PUBLIC_AUDIO_BASE=https://pub-<audio hash>.r2.dev/audio/v1
```

### Vercel (required — this is what makes production work)

Vercel → your project → **Settings** → **Environment Variables**. Add both, for
**Production** and **Preview**:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SPRITE_BASE` | `https://pub-<sprites hash>.r2.dev/sprites/v1` |
| `NEXT_PUBLIC_AUDIO_BASE` | `https://pub-<audio hash>.r2.dev/audio/v1` |

**No trailing slash** — the code strips one, but don't rely on it.

These are `NEXT_PUBLIC_*`, so they're **inlined at build time**. Changing them
requires a redeploy, not just a restart.

> If you skip this, production doesn't crash — it just quietly serves flat icons
> and no music, because `/sprites` and `/audio/replay` don't exist in the deployed
> bundle (both are gitignored).

### API (`CORS_ALLOWED_ORIGINS`) — check, don't change

The terrain image comes from your own API (`/v1/map-image`), and it's now loaded
with `crossOrigin="anonymous"`. Your API sends `Access-Control-Allow-Origin` only
for origins listed in `CORS_ALLOWED_ORIGINS`. Confirm your production web origin
is in that list — it almost certainly already is, since the rest of the app would
be broken otherwise.

---

## Step 9 — Verify

```bash
# 1. Assets are public and correctly keyed (expect HTTP 200 on both)
curl -I https://pub-<sprites hash>.r2.dev/sprites/v1/units/Terran/Marine_red.webp
curl -I https://pub-<audio hash>.r2.dev/audio/v1/terran-iron-front-protocol.mp3

# 2. CORS is actually being sent (expect an access-control-allow-origin header)
curl -I -H "Origin: https://sc2tools.app" \
  https://pub-<sprites hash>.r2.dev/sprites/v1/units/Terran/Marine_red.webp
```

Then in the deployed app, open a game with map playback and check:

- **Network tab** — sheets load from `pub-*.r2.dev`, all 200, no CORS errors in Console
- **Units are sprites**, not icons — this is the single best signal that sprites + CORS both work
- **Scale** — Thor ≈ 6× Marine, Hatchery dwarfs a Zergling
- **Motion** — units glide and face their direction of travel; workers cycle to and from mineral patches
- **Music** — starts on Play, swells near battle markers, doesn't pitch up at 8×
- **Canvas isn't tainted** — in the Console, `document.querySelector('canvas').toDataURL().length` should return a number rather than throwing a SecurityError

---

## What "fully working" looks like

- [ ] `git push origin main` done
- [ ] R2 token created, scoped to both buckets
- [ ] `sprites/v1/` populated (370 objects)
- [ ] `audio/v1/` populated (5 objects)
- [ ] public access enabled on both buckets
- [ ] CORS policy on both buckets
- [ ] both `NEXT_PUBLIC_*` vars set in Vercel, redeployed
- [ ] verified in a browser

---

## Known gaps and follow-ups

Not blockers, but you should know about them:

- **Upgrades panel is empty by design.** `MapPlayback` carries no upgrade events.
  Adding `UpgradeCompleteEvent` to the replay pipeline (sc2reader already emits it)
  would fill both the production rail and the "On Field" list.
- **Minerals/gas banked are omitted** from the top bar rather than faked — that
  series lives in the macro breakdown, not this payload. `ReplayStage` accepts an
  optional `banked` prop if you want to thread it in.
- **Spell effects need a fresh replay upload.** `casts` ships at payload `v5`, and
  there is no recompute path — existing games stay `v4` and simply draw no spells.
  Re-sync a replay with the latest agent to see them.
- **Building sprites have a faintly square shadow halo** (the shadow-catcher plane
  is cell-sized). Invisible on dark terrain, may show on bright maps. Re-bake fix.
- **`BroodLordCocoon` and `OverlordCocoon` are the same image** — SC2 genuinely
  ships one egg model for both morphs.
- **Sprite legibility at true scale**: a Marine is ~10px on a 1280px stage. That's
  geometrically correct and comparable to SC2's own max zoom-out, but *smaller*
  than the old flat icon. `SPRITE_WORLD_GAIN` in `MapReplayer.tsx` is the one dial
  if you decide legibility should beat fidelity.
