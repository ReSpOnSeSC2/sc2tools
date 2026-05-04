# Launch hardening runbook

Companion to [`SETUP_CLOUD.md`](SETUP_CLOUD.md). The code side of stage K
is in place — this doc covers the account-side checklist plus the
operational scripts that ship with the repo.

## Code-side — already in this repo

- **GDPR data export.** `GET /v1/me/export` returns the full per-user
  archive as JSON; UI is in /settings → Backups → Export.
- **GDPR account deletion.** `DELETE /v1/me` permanently wipes every
  per-user record. UI in the same panel.
- **Manual snapshots.** `GET / POST /v1/me/backups` and
  `POST /v1/me/backups/:id/restore` give point-in-time backups stored
  in the `user_backups` collection.
- **Privacy + ToS pages.** [/legal/privacy](../../apps/web/app/legal/privacy/page.tsx)
  and [/legal/terms](../../apps/web/app/legal/terms/page.tsx).
- **Cookie consent banner.** [`CookieBanner.tsx`](../../apps/web/components/CookieBanner.tsx),
  surfaced from the root layout.
- **Sentry stubs.** Soft-imported in
  [`apps/api/src/util/sentry.js`](../../apps/api/src/util/sentry.js)
  and [`apps/web/lib/sentry.ts`](../../apps/web/lib/sentry.ts) — no-op
  until you install `@sentry/node` / `@sentry/nextjs` and set the DSN.
- **Render autoscaling + healthcheck.** `render.yaml` sets
  `numInstances: 1`, `minInstances: 1`, `maxInstances: 3`,
  `targetCPUPercent: 70`, and `healthCheckPath: /v1/health`.
- **Load test script.** `scripts/load_test.mjs` simulates 50 concurrent
  agents posting games; fails CI if p95 > 1s or any 5xx.

## Account-side checklist

These can ONLY be done by the human user — they require third-party
account creation, payment cards, or DNS access.

### 1. Sentry

1. Sign up at https://sentry.io (free tier covers our volume).
2. Create projects: `sc2tools-api` (Node) and `sc2tools-web` (Next.js).
3. Install the deps:
   ```bash
   npm install --workspace apps/api @sentry/node
   npm install --workspace apps/web @sentry/nextjs
   ```
4. Set env vars:
   - **Render** (`apps/api`): `SENTRY_DSN=<api project DSN>`,
     optionally `SC2TOOLS_ENV=production`.
   - **Vercel** (`apps/web`): `NEXT_PUBLIC_SENTRY_DSN=<web project DSN>`,
     `SENTRY_AUTH_TOKEN=<token from Sentry org settings>`,
     `SENTRY_ORG=<your org slug>`, `SENTRY_PROJECT=sc2tools-web`.
5. Run `next build` once locally with the auth token set; source maps
   will upload automatically. Confirm in Sentry's "Source Maps" tab.

The `apps/api/src/util/sentry.js` module is invoked at boot in
`server.js` and inside the error handler — no extra wiring needed.

### 2. MongoDB Atlas alerts

In Atlas → Project → Alerts → "Add":

| Alert                                          | Threshold         | Action |
| ---------------------------------------------- | ----------------- | ------ |
| Connections > 80% of max                       | sustained 5 min   | email  |
| Replication lag                                | > 60 s            | email + Slack |
| Backup failure                                 | any               | email + Slack |
| Cluster CPU                                    | > 80% for 10 min  | email  |

Atlas has a built-in template for "Standard production set" — start
there and adjust. Backups: Atlas → Cluster → "Backup" → Continuous
Cloud Backup, retain 7 days. The free `M0` tier doesn't support
continuous backups; you'll need at least M2/M5 ($9/mo).

### 3. Cloudflare WAF

1. Add the apex domain (`sc2tools.app`) to Cloudflare (free plan).
2. Update the registrar's nameservers to Cloudflare's.
3. In Cloudflare → DNS, set:
   - `A api.sc2tools.app` → Render's IP (proxied: orange cloud).
   - `CNAME sc2tools.app` → `cname.vercel-dns.com` (proxied).
   - `CNAME www` → `cname.vercel-dns.com` (proxied).
4. Cloudflare → Security → WAF → enable the OWASP Core Ruleset on
   high sensitivity. Most rules are off by default on the free plan;
   the ones you want are "Cloudflare Managed Ruleset" + "Bot Fight
   Mode."
5. Cloudflare → Speed → Caching: set "Browser Cache TTL" to 4h on
   `*.js`, `*.css` (Vercel CDN already does this; Cloudflare just adds
   another layer).
6. Verify with `curl -I https://api.sc2tools.app/v1/health` —
   `cf-ray` header should be present.

Render edge already terminates TLS, so this is a defence-in-depth
layer — Cloudflare can drop attack traffic before it ever hits
Render.

### 4. Status page

Better Uptime free tier:

1. https://betteruptime.com → Sign up → Add monitor.
2. Monitor `https://api.sc2tools.app/v1/health` every 1 min.
3. Monitor `https://sc2tools.app` every 1 min.
4. Create a status page → custom domain
   `status.sc2tools.app`. Add a `CNAME` in Cloudflare pointing at
   the Better Uptime hostname.
5. Subscribe yourself to incident emails.

The `<a href="https://status.sc2tools.app">` link in the website
footer is already wired — once the domain resolves it'll just work.

### 5. Pen test

```bash
docker run -v $(pwd):/zap/wrk -t zaproxy/zap-stable \
  zap-baseline.py -t https://staging.sc2tools.app -r zap-baseline-report.html
```

Run against the **staging** environment, not prod (the agressive scan
trips Cloudflare's rate limits otherwise). Triage anything ≥ "high"
severity before launch.

### 6. Load test

```bash
# Provision a test user, mint a device token, then:
API_BASE=https://staging.sc2tools.app \
LOAD_TEST_TOKEN=<device token> \
node scripts/load_test.mjs --agents 50 --games-per-agent 20
```

Target: p95 < 1000ms, zero 5xx. Watch Render's metrics during the
run — if CPU pegs at 100% with one instance, autoscaling should kick
in within 2 min.

## Suggested order

1. Buy domain, point at Cloudflare, add DNS records (1h)
2. Spin up Render + Vercel from the existing `render.yaml` and
   Vercel project (1h — see `SETUP_CLOUD.md`)
3. Atlas backups + alerts (30 min)
4. Sentry signup, install deps, ship a deploy with DSNs set (1h)
5. Status page (15 min)
6. Run load test, verify p95 (30 min)
7. Run ZAP scan, triage (1h)

About a half-day end-to-end. The privacy / ToS / cookie / GDPR work
is already in the codebase — it's live the moment you deploy.
