# 0056 — Public metadata and share images

Status: accepted for metadata; cache revalidation follows separately.

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
Unavailable/stalled reads produce a neutral branded card cached for 60 seconds;
successful public cards use the existing 300-second cache window. No user
token, integration or new service is involved.

## Validation

Actual PNG tests exercise the renderer, all five icon/deadline cards and the
neutral fallback. Held-header/body tests verify the public read deadline.
Projection tests cover positive criteria, legacy precedence, bounds, anonymous
authors and private-field omission. A real HTTP test checks every emitted
sitemap route for its canonical, own OG title and matching Twitter title.

## Follow-up boundary

Community ISR/tag invalidation, API cache headers and corpus caching are PR B.
They do not ship implicitly with this metadata change. That change must reuse
the existing guides HMAC verification, preserve last-good renders on failures
and document its operator secret without enabling an integration or adding
infrastructure.
