# ADR 0067: Share an end-date session gap without changing consumer scope

Status: Implemented and locally verified; exact-head CI and delivery pending.
Date: 2026-10-27.

## Context

Live records, personal momentum and session quizzes could group the same play
burst differently. Calendar resets also conflict with active play crossing
midnight. Users need one adjustable definition while existing statistics retain
their eligibility/filter and denominator rules.

## Decision

Store an optional integer gap of 15–480 minutes on Profile. Null means Auto;
omitted legacy PUT fields preserve it. Auto is 240 minutes when any overlay-token
record exists, including revoked/rotation-pending, otherwise 90. Existing overlay
accounts keep their four-hour live default through credential rotation.

Group by stored replay-END instants and split only when the gap is strictly
greater than the selected minutes. Equality, midnight and DST stay connected.
Eligible unknown outcomes bridge before decided statistics. Shared pure kernels
retain deterministic supported-scalar ordering and duplicate multiplicity. Mongo
momentum applies scalar BSON Date before ordering/arithmetic, after indexed
bounds, without rescuing legacy arrays/strings/numbers.

Apply the policy to live/overlay aggregates, personal momentum and both session
quizzes. Preserve consumer universes: Today retains 14-day candidates, future
exclusion, inclusive manual anchor and MMR/region behavior; calendar-day dashboard
totals keep their scope. Global momentum retains independent player/race/ladder/
size partitions and its existing 90-minute/explicit analysis gap.

Use bounded process-local owner revisions/session gates. Invalidate around
semantic policy attempts, including unknown ACKs; capture before resolution and
assert after the last await before HTTP 200/304/private emits. Keep leases private.
A tiny authenticated no-store read requires positive current lifetime admission.
Pending Profile drafts stay local; only an admitted PUT ACK publishes shared
cache state, and advisory cache failure cannot falsify confirmed success.

## Consequences and limits

The preference/endpoints/overlay metadata are additive. No migration, new index,
unbounded cache, external service, flag activation or agent release is needed.
Existing filters and omitted-write compatibility remain intact. Session-history
pages and list/detail/current APIs are separate follow-up work.

See the [checkpoint](../handoff/sessions-core-checkpoint.md) for local targeted,
browser/build and synthetic explain receipts, retained incomplete accessibility
observations and final delivery gates. This process-local design does not
establish production cost, universal legacy BSON/JSON parity or distributed/
out-of-band writer coherence.
