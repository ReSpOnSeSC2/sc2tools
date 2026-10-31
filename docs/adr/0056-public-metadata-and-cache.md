# 0056 — Public metadata and share images

Status: accepted for metadata and bounded public cache revalidation. Its cache
contract (Follow-up boundary) is superseded by ADR 0074: since PR #758, Community
pages and decorated Community API reads are uncached.

## Context

Public links need their own canonical URL, coherent social title and a useful
preview. Shared guide metadata must resolve URLs consistently. Public dates
must render identically on the server and client. A failed public API must not
leave a social-image request waiting indefinitely.

## Decision

Use small `lib/seo` helpers for validated site origins/absolute URLs,
word-boundary descriptions, route metadata and fixed en-US/UTC public dates.
Keep query parameters out of canonical URLs. Existing shared guide SEO uses
the same URL/description helpers. Authentication layouts are noindex, and
robots discovery excludes the private application and auth subroutes.

Community build/author and Try/Download social images use the existing
Next ImageResponse runtime and guide palette. Only public DTO fields enter
the card. Build cards show up to five positive rule deadlines, explicitly
labelled as deadlines rather than observed play. Negative/maximum constraints
are omitted. Author/provenance IDs and private notes never enter these cards.

Icons resolve only through the repository registry and a bounded local PNG
path; they are embedded as data URLs, with text-only fallback. Trace the local
icon directories into the community image function. Satori uses separate
backgroundColor/backgroundImage, as in the existing Guide image renderer.

Public image data reads have a 2.5-second deadline covering headers and JSON.
Unavailable/stalled reads produce a neutral branded card with a 60-second
window; successful public cards use 300 seconds. Community build/author cards
honor the later purge-configuration guard below and use no-store when unset.
No user token, integration or new service is involved.

## Validation

Actual PNG tests exercise the renderer, all five icon/deadline cards and the
neutral fallback. Held-header/body tests verify the public read deadline.
Projection tests cover positive criteria, legacy precedence, bounds, anonymous
authors and private-field omission. A real HTTP test checks every emitted
sitemap route for its canonical, own OG title and matching Twitter title.

## Follow-up boundary

PR B adds the following cache contract without activating operator configuration:

- General Community server reads use a 300-second data cache tagged `community`
  and, for a valid public slug, `community-build:<slug>`. Without the web purge
  secret these reads and user-derived social cards remain uncached. Detail
  outages throw into the existing unavailable boundary. The native data cache
  retains a prior successful response when a timed background refresh fails,
  allowing the page to render its last-good public data. An uncached failure
  remains unavailable rather than becoming a false missing resource.
- Successful public Community API responses use `s-maxage=60` and
  `stale-while-revalidate=600`. Private, owner, admin, missing and error responses
  remain `private, no-store`. The site-stats proxy uses 15/60 seconds; its upstream
  read remains uncached, and errors remain uncached.
- Opponent pages and API responses deliberately remain uncached, including when
  purge is configured. The planned 21,600-second opponent render and general
  public API header would bypass the current removal/privacy floor if a purge
  failed. A bounded one-hour service LRU instead avoids repeated materialization:
  every request still checks authoritative removal, identity and five-owner
  admission before reading it. The LRU holds at most 128 payloads of 64 KiB,
  with two concurrent cold materializations and generation-fenced late results.

The optional Community sender reuses the guides raw-body HMAC protocol with
scope `community`, a separate shared secret, five-minute signature tolerance,
4 KiB/2-second receiver body bounds, and a five-second sender deadline. One
active notification and one coalesced pending notification bound work. It logs
only a status or fixed failure label. Missing configuration is a no-op; failed
notifications do not turn a committed user mutation into an error.

Publish/update/unpublish, moderation, rounded-score changes, admin edits and
game visibility/deletion/GDPR/restore paths retire the relevant service caches
and notify the tag receiver. Unknown write outcomes conservatively invalidate
before any fallible verification read; known no-op votes and validation failures
do not purge. Owner game changes reuse the existing private invalidators through
one narrow GDPR callback. No new query, durable revision, index, worker or service
is introduced. Purge is best effort, so publication copy promises no fixed
seconds-to-visibility guarantee. Configuration and its limits are documented in
the deployment guide; no production secret or environment value is changed.

The existing Community loading boundaries can send HTTP 200 before a child
`notFound()` supplies Next's 404 fallback and noindex. PR B preserves this
streaming behavior, including absence of the prior content, rather than
claiming a raw HTTP status improvement. The API's missing-resource responses
remain strict 404/no-store. Production HTTP tests compare the three affected
cases against the exact released-main build. They also age only a synthetic
fetch artifact to prove timed last-good behavior, then start the same compiled
app without the secret to prove the uncached default despite a warm disk cache.
