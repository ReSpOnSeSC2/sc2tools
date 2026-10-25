# Public cache, PR B

General public Community reads use a configured 300-second tagged cache, with
the existing guides HMAC protocol under a separate Community scope and secret.
Default configuration sends nothing and leaves user-derived public reads and
share cards uncached. Public API success headers use 60/600 seconds and the
site-stats proxy uses 15/60; private, missing and error responses use no-store.
No secret, integration, environment or production data is changed.

Opponent pages deliberately keep no-store at the API, Next fetch and rendered
page layers. The planned six-hour render is unsafe if a best-effort purge fails
after removal or a five-owner floor change. A bounded one-hour service LRU
reduces aggregate materialization while checking current removal, identity and
floor on every read. It has 128 entries, a 64 KiB payload cap, two cold workers
and generation fencing. No new corpus query, index or infrastructure is added.

Publish/update/unpublish, rounded vote-score changes, moderation, admin edits
and game hide/unhide/delete/restore/GDPR paths retire caches. An uncertain write
outcome invalidates before fallible verification; pure validation failures and
known no-op votes do not purge. The narrow game-mutation callback is separate
from publication invalidation and reuses existing owner-private invalidators.
The independent seam is preserved in `d3830616` and is consumed by Scorecard.

Independent review reproduced a commit-then-reject removal with a warm cache,
then confirmed its correction: one purge and zero warm entries, preserving the
original mutation rejection. Review also identified the unsafe configured Next
opponent cache; both HTTP and rendered opponent reads now stay uncached. No
remaining API/privacy blocker was found in the corrected source.

Current-main integration preserves released Reference validation/projection and
the passive dossier scrolling fix. The sole editor merge conflict was additive;
the resulting hook equals released main exactly. Integrated cache/lifecycle API
proof passes 89 cases in eight suites; affected web and editor/reference proof
passes 125 in 15 files, plus four scoped cold-error recovery cases. Types and
strict new-source lint pass. An existing Admin Studio lease fixture failed once;
isolated and complete 13-case reruns passed unchanged, as did the final run.

Required engine `25b300818c31d41b` smoke and production build pass, with every
unchanged budget: Community184.6/190, Today238.7/240, opponent448.2/500,
Dock215.7/225 and widget323.8/325 kB. No budget or engine source is changed.

The owned `tests/manual/public-cache-http.cjs` first starts the parent's exact
main9f production build (`--baseline`; override its path with
`PUBLIC_CACHE_BASELINE_WEB`), using only synthetic API fixtures. Nine checks
establish existing streamed200 +Next404 fallback/noindex and no prior content
for floor/removal/missing-build cases. It then starts this branch and passes
33 actual HTTP checks: current admission and no-store after a failed purge,
real signed tag refresh, site15/60 vs503no-store, and last-good public data after
a timed background503. It ages only the synthetic fetch artifact's timestamp
and restarts memory; no clock, source or real data changes. The same compiled
app with runtime secretunset bypasses a previously warm cache, reads new public
versions, returns503 from the receiver and emits an uncached actual social PNG.
Both loopback servers exit;3210/8080 are released.

An initial strict web HTTP404 assumption failed on both this branch and exact
main. The final assertions preserve the measured baseline and strict API404,
fallback/noindex/no-content checks. No loading restructure is included. An
unconditional route-ISR addition was rejected by automatic approval review for
its uncached-default risk and remains unapplied. Native timed data-cache
behavior proves last-good content without that change. Final remote checks
remain merge gates. No production account is used for validation.
