# Hosting resource usage — 2026-10-26

The owner asked whether Vercel's Exceeded free resources warning would cost
money and how to fix it. Read-only dashboard inspection confirms this team
uses the free Hobby plan. No billing, plan, quota, retention, deployment,
branch, cache, asset, integration or live data was changed by the inspection.

## Observed usage

The same Last 30 Days view reports Deployment Storage24.37GB/10GB, Functions
Storage12.11GB/10GB and Fluid Active CPU4h26m/4h (the owner's earlier image was
4h25m). Project grouping attributes23.92GB deployment storage,12.11GB function
storage and4h26m CPU to sc2tools. Other team projects explain the small remaining
deployment-storage amount. These are reporting-window values, not a file-level
or per-deployment inventory. Current production5b4af736 is visibly Ready with
sc2tools.com assigned; no claim about future quota enforcement is made.

Official sources consulted October26:

- https://vercel.com/docs/plans/hobby
- https://vercel.com/docs/deployment-storage
- https://vercel.com/docs/deployment-storage/optimize
- https://vercel.com/docs/deployment-retention

Hobby has no automatic paid overage; exceeding limits can restrict deployment
or features. Storage output and retention are separate from CPU usage. Paid
plan pricing is not an authorization or recommendation to upgrade.

## Bounded immediate code change

The existing api-keepalive workflow includes six website GETs every five
minutes, nominally51,840 requests per30days before retries if every scheduled
run fires. The two web ping/warmup endpoints are forced dynamic/no-store. No
actual job firing count or CPU attribution was established from source.

Remove only that web-warming step. Keep the workflow schedule, concurrency,
permissions, Render /v1/ping and /v1/health requests and their retry behavior.
Keep the public status page and endpoints. This reduces future synthetic web
traffic; it does not reclaim saved deployments or undo accrued CPU usage.

Independent four-path source review found no blocker. YAML parses with unique
keys; name, triggers, permissions, concurrency and all job properties match
the original. The sole retained API step is byte-identical. Installed Git
Bash `-n` syntax checking passes without executing any request. The sandbox
attempt could not start MSYS (0xC0000022); its setup failure and successful host
proof remain in `.cache/hosting-resource-usage/`. No source repair was needed.
No new application tests, production build or browser are required
for removing this reversible schedule step. Existing web/API behavior is not
modified. Final exact-head remote checks and merge remain pending.

## Further findings and boundaries

A source-only audit found270.25MB in the primary checkout's public tree, mostly
sprites162.55MB, replay-attacks28.05MB and alerts21.60MB. Repeated deployments
and retention can amplify storage; no deployed deduplication or exact file
attribution was established. Do not delete required runtime or replay assets.

The primary checkout's retained October23 Windows build traces native
translation dependencies into the overlay widget function. Its68.77MB local
trace is a packaging risk, not the current Linux deployment size. Verify exact
deployed output before changing tracing or the browser translation boundary.

Current public stats and active presence proxy requests can also consume web
CPU. Preserve hidden/offline/idle guards, consent and private freshness. Cache
or cadence changes require their own reviewed contracts and meaningful proof.

## Approved preview retention change

The actual project policy was30days in all four categories. Root presented
the exact scope: change only Pre-Production retention to1week, retaining
Production at30days, with explicit notice that older preview versions and
review history are automatically removed. The owner replied "Approve 1-week
preview retention". Root selected1week, saved, then reloaded the project
Build and Deployment page. The persisted values visibly read Canceled30days,
Errored30days, Pre-Production1week and Production30days; Save was disabled.
This applies only to sc2tools. No manual deployment deletion, branch or alias
removal, billing/plan change or hosting retry occurred.

Usage may lag policy cleanup and rolling-window reporting. No reclaimed GB or
CPU amount is claimed. Active aliases/branches and recent deployment
exceptions may retain output beyond the selected period. Further manual
cleanup requires its own concrete reviewed scope and action-time approval.
Existing program work and every local proof/ref/cache remain preserved.
