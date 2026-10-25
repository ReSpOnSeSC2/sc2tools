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

Current local proof includes 21 disposable-Mongo lifecycle regressions, the
bounded sender/LRU tests, 83 affected web assertions in 12 files, API types and
36 related game-controls/backups/GDPR tests. An existing Admin Studio lease
fixture failed once; isolated and complete 13-case reruns passed unchanged.
Production HTTP behavior, current-main integration, unchanged budgets and final
remote checks remain required before merge. No production account is used for
validation.
