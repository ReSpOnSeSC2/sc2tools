# ADR 0074: Public caching, reconciled with the literal plan

Status: Accepted, October 31, 2026. Documentation only. It changes no runtime
behavior, flag, provider, secret or production configuration. It supersedes the
cache contract in ADR 0056 (`docs/adr/0056-public-metadata-and-cache.md:45-66`)
and reconciles the second remaining requirement of roadmap item
`public-pages-seo-and-cache` (ledger ordinal 64); the first, configured purge
delivery in production, stays with the owner.

## Context

- **The literal plan.** PR B of the canonical plan for this item
  (`docs/handoff/plan/final-plan.json:1685`) asked for Community fetches with a
  300-second revalidation and tags, detail pages that throw on API failure so
  the last good render is served, a signed revalidation receiver pinged by the
  API after publication changes, `public, s-maxage=60,
  stale-while-revalidate=600` on public Community API reads, `public,
  s-maxage=15, stale-while-revalidate=60` on the site-stats proxy, a six-hour
  render plus a one-hour LRU for the Community opponent page, and the secret
  documented in `docs/DEPLOYMENT_GUIDE.md`. Its how-to (`:1692`) adds publish
  copy saying the build appears within seconds.
- **What shipped first.** PR #749 implemented a configured 300-second tagged
  cache and the planned API headers, and kept opponent pages `no-store`
  (`docs/handoff/public-cache-checkpoint.md:1-15`; ADR 0056).
- **What changed after.** PR #758 (consent-controlled public player pages,
  October 26) made Community reads uncached at both layers, because decorated
  Community responses carry current publication capabilities that a
  best-effort purge cannot keep fresh after a profile opt-out:
  - the web fetches Community data with no revalidation and no tags, even with
    the purge configured (`apps/web/lib/communityCache.ts:1-8`; the test "keeps
    capability admission fresh even when optional purge is configured",
    `apps/web/lib/__tests__/communityCache.test.ts:9-14`);
  - the API sends `no-store` on decorated Community reads whenever public player
    pages are wired, which they always are
    (`apps/api/src/routes/community.js:50-52`, `apps/api/src/app.js:1512-1514`).
- **The open requirement.** "Reconcile original literal public-cache
  requirements with the documented privacy-safe no-store exceptions." ADR 0056,
  `docs/seo.md`, the owner setup guide and the deployment guide still described
  the earlier cache.

## Decision

Each part of the plan maps to what the source does now:

| Plan | Now |
| --- | --- |
| Community fetches with `revalidate: 300` and `community` plus per-build tags | Not as planned: uncached. `communityCacheOptions` returns no revalidation and no tags for the directory, build and opponent pages, with or without the purge (`apps/web/lib/communityCache.ts:6-8`, used at `apps/web/app/community/(directory)/page.tsx:42`, `apps/web/app/community/builds/[slug]/page.tsx:52`, `apps/web/app/community/opponents/[pulseId]/page.tsx:46`). Community social cards render with `revalidate = 0`. |
| Detail pages throw on API failure so the last good render is served | Not provided: with no data cache there is no last good render; a failed read shows the unavailable and retry boundary. |
| Signed receiver `app/api/revalidate-community` with the guides HMAC, scope `community` | Present. With its secret it revalidates the `community` tag, the `/community`, `/players` and `/p` layouts and `/sitemap.xml` (`apps/web/app/api/revalidate-community/route.ts:42-46`); without it, it answers 503. The web's one remaining cached Community read is the sitemap's. |
| API pings after publish, update, unpublish, moderation and rounded vote changes | Present, plus admin edits and game visibility, deletion, restore and GDPR paths; a no-op while the API's URL and secret are unset (`docs/DEPLOYMENT_GUIDE.md`, "Current app: optional Community cache revalidation"). |
| `public, s-maxage=60, stale-while-revalidate=600` on public Community API reads | Not as planned since PR #758. The build list, build detail and arcade-universe reads send `no-store` (`apps/api/src/routes/community.js:52`, `:119`, `:138`, `:208`); author profiles send `no-store` (`:234`); opponents and every other route default to `private, no-store` (`:55`). Only the content-only `/v1/community/sitemap` sends 60/600 (`:194`). |
| `public, s-maxage=15, stale-while-revalidate=60` on the site-stats proxy | Present (`apps/web/app/api/site/stats/route.ts:7`); a 503 is `no-store`. |
| Opponent page: six-hour render plus a one-hour LRU | Not the six-hour render. The API, the fetch and the rendered page stay uncached, since a failed purge after a removal or a five-owner floor change would serve stale opponent data (`docs/handoff/public-cache-checkpoint.md:10-15`). The one-hour service cache (128 entries, 64 KiB each) sits behind the caller's fresh removal, identity and floor checks (`apps/api/src/services/communityOpponentCache.js:4-14`). |
| Publish copy promises the build appears within seconds | Not promised: purge delivery is best effort, so the UI makes no unconditional "within seconds" promise. |
| The secret documented in the deployment guide | Present. The deployment guide's Community cache text is corrected with this ADR. |

So the privacy-safe exceptions are: every Community page read and its social
cards, and the decorated Community API reads and author profiles (capability
freshness after opt-out, since PR #758); and the opponent page's render
(removal and floor freshness, since PR #749). The signed receiver, the
site-stats headers and the sitemap's headers are as planned.

## What remains for the item

- Configured purge secrets and receiver in production, and the API's actual
  deployment and activation state. They are provider settings this program
  does not change; the source makes no edge-caching claim from them.

## Consequences

- No runtime change. ADR 0056's status line, `docs/seo.md`, the owner setup
  guide (`docs/handoff/plan/owner-setup.md`) and `docs/DEPLOYMENT_GUIDE.md` no
  longer describe a 300-second Community cache or 60/600 headers on decorated
  reads.
- A later change that caches Community pages or their API reads again needs a
  way to keep publication capabilities fresh after an opt-out, not only a
  purge.
