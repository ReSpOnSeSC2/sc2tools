# ADR 0074: Public caching, reconciled with the literal plan

Status: Accepted, October 31, 2026. Documentation only. It changes no runtime
behavior, flag, provider, secret or production configuration. It reconciles the
second remaining requirement of roadmap item `public-pages-seo-and-cache`
(ledger ordinal 64); the first, configured purge delivery in production, stays
with the owner.

## Context

- **The literal plan.** PR B of the canonical plan for this item
  (`docs/handoff/plan/final-plan.json`, item `public-pages-seo-and-cache`)
  asked for Community fetches with a 300-second revalidation and tags, a
  signed revalidation receiver pinged by the API after publication changes,
  `public, s-maxage=60, stale-while-revalidate=600` on public Community API
  reads, `public, s-maxage=15, stale-while-revalidate=60` on the site-stats
  proxy, a six-hour render plus a one-hour LRU for the Community opponent page,
  and the secret documented in `docs/DEPLOYMENT_GUIDE.md`.
- **What shipped first.** PR #749 implemented a configured 300-second tagged
  cache and kept opponent pages `no-store`
  (`docs/handoff/public-cache-checkpoint.md:1-15`).
- **What changed after.** PR #758 (consent-controlled public player pages,
  October 26) made Community reads uncached even when the purge is
  configured, because the decorated Community responses carry current
  publication capabilities that a best-effort purge cannot keep fresh after a
  profile opt-out (`apps/web/lib/communityCache.ts:1-8`; the test "keeps
  capability admission fresh even when optional purge is configured",
  `apps/web/lib/__tests__/communityCache.test.ts:9-14`).
- **The open requirement.** "Reconcile original literal public-cache
  requirements with the documented privacy-safe no-store exceptions." The
  deployment guide still promised the 300-second page cache.

## Decision

Each part of the plan maps to what the source does now:

| Plan | Now |
| --- | --- |
| Community fetches with `revalidate: 300` and `community` plus per-build tags | Uncached: `communityCacheOptions` returns no revalidation and no tags for the directory, build and opponent pages, with or without the purge (`apps/web/lib/communityCache.ts:6-8`, used at `apps/web/app/community/(directory)/page.tsx:42`, `apps/web/app/community/builds/[slug]/page.tsx:52`, `apps/web/app/community/opponents/[pulseId]/page.tsx:46`). |
| Signed receiver `app/api/revalidate-community` with the guides HMAC, scope `community` | Present. With its secret it revalidates the Community tag and the `/community` and `/players` layouts (`apps/web/app/api/revalidate-community/route.ts:42-44`); without it, it answers 503. |
| API pings after publish, update, unpublish, moderation and rounded vote changes | Present, plus admin edits and game visibility, deletion, restore and GDPR paths; a no-op while the API's URL and secret are unset (`docs/DEPLOYMENT_GUIDE.md:356-377`). |
| `public, s-maxage=60, stale-while-revalidate=600` on public Community API reads | Present on public success responses (`apps/api/src/routes/community.js:5`); private, missing and error responses are `no-store`. |
| `public, s-maxage=15, stale-while-revalidate=60` on the site-stats proxy | Present (`apps/web/app/api/site/stats/route.ts:7`); a 503 is `no-store`. |
| Opponent page: six-hour render plus a one-hour LRU | Not the six-hour render. The API, the fetch and the rendered page stay uncached, since a failed purge after a removal or a five-owner floor change would serve stale opponent data (`docs/handoff/public-cache-checkpoint.md:10-15`). A one-hour, 128-entry, 64 KiB service cache checks removal, identity and the floor on every read (`apps/api/src/services/communityOpponentCache.js:8-14`). |
| The secret documented in the deployment guide | Present (`docs/DEPLOYMENT_GUIDE.md:356-377`). Its paragraph on the page cache is corrected with this ADR. |

So the privacy-safe exceptions are: every Community page read (capability
freshness after opt-out, since PR #758), and the opponent page's render (removal
and floor freshness, since PR #749). The HTTP headers and the signed receiver
are as planned.

## What remains for the item

- Configured purge secrets and receiver in production, and the API's actual
  deployment and activation state. They are provider settings this program
  does not change; the source makes no edge-caching claim from them.

## Consequences

- No runtime change. `docs/DEPLOYMENT_GUIDE.md` no longer says Community pages
  use a 300-second cache when the purge is configured.
- A later change that caches Community pages again needs a way to keep
  publication capabilities fresh after an opt-out, not only a purge.
