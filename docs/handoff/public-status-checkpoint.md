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

The final combined tree includes opponent columns #754 at `64e3a771` and passes
the production build and every unchanged bundle budget. `/status` prerenders at
119 kB first load. Today 238.7/240 kB, opponents 120.5/180, dossier 451.6/500,
overlay 239.7/240 and widget 323.8/325 all pass. Engine `25b300818c31d41b`
(1.6.12/Python 3.14.2) rebuilt and smoke-parsed successfully. Actual prerendered
HTML has two Unknown badges, two Not checked yet labels, no Reachable badge and
no external Clerk script.

The manual browser fixture uses actual route/components, committed fonts and
production CSS with synthetic framework boundaries and two loopback public
probes. **172 assertions pass** at 320/390/768/1440 in light and dark themes:
initial Checking, independent success/HTTP 503 results, unknown payload/network
responses, keyboard Refresh and Tab focus, timestamps, 44 px controls, viewport
containment and no focus/online polling. Probe requests omit cookies and
Authorization; no external requests, writes or page errors occurred. The 80
probe observations include browser transport retries for deliberate network
failures. Existing installed Chromium required normal local output permissions;
no browser was installed. Browser/server stopped and port 3273 was released.

Root inspected four representative owned captures (light 320, dark 1440 and
partial results in both themes at 390). All are contained and legible. These
four are checked in; ten captures and logs remain in `.cache`.

This is a pre-deployment checkpoint. Require fresh exact-head CI, then deploy
the primary route before attaching the alias. Record final live route and alias
verification in the attached PR. Preserve primary domains and DNS records.

PR755 responsive CI passed; full web CI found one outdated structured-data
test that assumed the OBS question was the first troubleshooting FAQ. It now
checks the existing OBS and new status entries independently of editorial order.
All seven FAQ/sitemap checks and strict test-file lint pass. Runtime code and
the validated production build are unchanged by this correction.

The first preview hit Vercel's rolling deployment limit. The required FAQ-fix
head later deployed normally and passed its exact-head web/responsive/Vercel
checks. PR755 squash-merged as `c7bf67e7e9cbf8ea8eac4706844b96d4a3ba7696`,
with fresh merge-tree equality verified before merge.

## Live verification — 2026-10-25

Production did not automatically create a deployment for the merged head. Root
created one normal Production deployment for verified mainc7 through the
existing authenticated Vercel project. It was accepted without changing plans
or environments: `sc2tools-5ay50jl2x-jonathan-laymans-projects.vercel.app`.
No preview was promoted with potentially different environment variables.

After primary `/status` returned200 with the expected status heading, root
attached the exact `status.sc2tools.com` hostname to that project's Production
environment. Vercel reports Valid Configuration; both pre-existing primary
domains remain. No DNS, credentials, paid service or account change was needed.

- HTTPS alias root returns308 to `https://sc2tools.com/status`.
- A synthetic `/app/example?probe=synthetic` also returns308 to the same clean
  URL, proving incoming path/query are discarded.
- Primary status returns200, with honest Unknown results in initial HTML.
- Actual Chrome visit through the alias lands on primary `/status`. Website
  and API both showed Reachable at19:16:30EDT; manual Refresh updated both
  timestamps to19:16:36EDT and retained Reachable results.
- Root inspected the completed live screenshot and left the public status tab
  as a deliverable. No auth boundary or app chrome rendered.

PR755 is shipped and the reported DEPLOYMENT_NOT_FOUND issue is resolved.
