# Public status page

The owner reported `status.sc2tools.com` showing Vercel
`404 DEPLOYMENT_NOT_FOUND` and confirmed no external status service was ever
configured. DNS pointed to Vercel, but the hostname was absent from the existing
sc2tools project's domain list. The previous hardening document described an
unimplemented external status service; it was not evidence of a live monitor.

## Contract

- `/status` is a public standalone page outside Clerk, realtime, presence,
  analytics, normal app chrome and service-worker registration. Its middleware
  bypass is exact; protected routes retain the existing Clerk wrapper.
- The exact `status.sc2tools.com` hostname redirects with HTTP 308 to the fixed
  `https://sc2tools.com/status` URL, discarding incoming paths and queries.
  This requires attaching the alias to the existing Vercel project's Production
  environment after the page has deployed; DNS alone does not attach it.
- Initial HTML says Unknown / Not checked yet. One client check on opening,
  including React StrictMode, requests same-origin `/api/ping` and the existing
  configured API's `/v1/ping`. Refresh is explicit; there is no polling.
- Both are public GETs with credentials omitted, no-store caching, no referrer
  and no redirects. They do not use account API helpers, JWTs, `/v1/health`,
  MongoDB, replay blobs, writes, cron jobs or additional infrastructure.
- Each fetch and JSON body shares a four-second deadline. Aborts, navigation,
  unmounts and newer refreshes fence old results. An HTTP error is Unavailable;
  timeouts, browser/network/CORS problems or unexpected payloads are Unknown.
  Only a successful HTTP response with `status: "ok"` is Reachable.
- Results and timestamps describe this browser's observations. They make no
  claim about authentication, processing queues, database health, historical
  uptime or an independent monitoring system. The page shares website hosting.
- Missing/invalid production API configuration never falls back to a visitor's
  localhost. HTTP loopback is permitted only from a local website context.
- Footer and More link directly to `/status`. Troubleshooting Help explains
  the controls and limitations. No new account, token or paid service is needed.

## Verification and deployment

233 focused checks across 12 suites pass, including 36 status checks, 40
middleware cases, existing shell/chrome/footer/navigation, replay guards and
Help. Full web types and strict owned-source/test/manual-fixture lint pass.
The Help index still contains the same 88 articles and leaves no semantic
generated change. Initial tests reproduced and corrected a Windows module-name
collision: the component is `StatusChecks.tsx`, its helper is `reachability.ts`.

The manual browser fixture uses actual route/components, committed fonts and
production CSS with synthetic framework boundaries and two loopback public
probes. Browser/build/CI and hostname evidence will be recorded after execution.
Domain attachment has not yet been performed. Preserve primary domains and DNS.
