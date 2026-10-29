# ADR 0070: request-local maintained account statistics

Status: implementation candidate, October 28, 2026. Not released by this record.

## Decision

Keep eager ingest/wipe/restore maintenance and reuse its count/latest tuple only
from a fresh primary owner read. `/me` combines its existing summary and
onboarding preferences in that read. Doctor combines its existing profile and
replay-archive preferences. Public DTOs remain unchanged; proof fields never
cross the response boundary. Missing or rejected proof calls the unchanged
`GamesService.stats` once. No lazy repair, cross-request response cache, new
flag, background polling, infrastructure or provider request is introduced.

The reader requires transactional writer protocol 2, maintenance version 2 in
ready status, matching exact BSON owner `_id`, dedicated UUID revision and
exact mutation-epoch presence/value. Any `_gdprMutation` field blocks reuse,
including expired or falsy residue. Total must be a safe nonnegative integer;
latest must be a finite scalar Date or null. Positive total with null latest is
valid. Unsupported raw BSON remains the authoritative query's responsibility;
the reader must not normalize it. The bound covers the projected tuple, not
the full stored user document.

## Freshness and rollout ordering

The bounded macro recompute extension uses a named server-owned operation for
`macroScore`, optional `top3Leaks`, schema stamping and removal of the legacy
inline macro blob. Its filter is the exact owner/game plus the existing live
predicate, with no upsert. The descriptor and owner are copied before awaits;
callers cannot select neutrality for an arbitrary callback or patch. The shared
owner-first transaction body accepts an existing session and never nests a
transaction. Production dispatch still owns the original causal floor,
admission and drain lifecycle.
The composition regression proves same-session/no-nesting only. Any later
production caller must own that lifecycle and immutable inputs across its
outer retry closure before using the internal body.

Only a strict ready maintenance-2 tuple from that atomic owner's preimage can
carry unchanged under the new UUID, in the same transaction as the macro
update. Unqualified proof is retired without recounting history; the existing
reader fallback remains. Membership/date/eligibility writers retain eager
maintenance. This count-only proof is not an expanded chart dependency seal;
other non-count writers and any future retained-chart cohort gate are separate.
Detail-store reads/uploads remain outside transaction retry callbacks.

The bounded check-in extension adds four closed named operations: game update,
pending-queue dismissal, fresh pending mark and claimed live-record bind. Each
owns its existing complete game filter and no-upsert command. Only plain
`$set` stages on the operation's explicit check-in/label paths are admitted;
schema values must match the server stamp. Existing attribution expressions
and literal user text remain unchanged. Descriptors and owner identities are
BSON-copied before transaction/floor awaits; raw values that cannot round-trip
are rejected. Dismissal retains the existing maximum of 500 selected IDs.

PUT and dismissal capture once before their reads. Ingest forwards its admitted
batch identity to binding, which never recaptures after an epoch change or
between optimistic attempts. Direct service entry captures once. Live-record
claims/releases, option/suggestion reads and notifications retain their existing
order outside transaction retries. This does not make live-record and game
writes cross-collection atomic: the existing first-wins recovery checks an
uncertain game outcome before returning a claim. Strict count-only carry or
retirement uses the same owner-first transaction and admission lifecycle as
macro recompute; no expanded chart seal or serving-cohort certification is
minted. Other classification/rename/non-count writers remain separate.

Maintenance 1 is never a maintenance-2 delta base. Its first eager
membership/date/eligibility transaction
bootstraps with the original Mongo count and `sort({date:-1}).limit(1)` query.
Qualified later mutations keep bounded subset deltas. The exact Mongo `$ne`
eligibility, legacy array behavior and `first.date || null` behavior remain.

Before minting maintenance 2, each connected client acknowledges a majority
collection read causally after the current primary's actual operationTime and
checks primary continuity. Every new writer session advances to that floor
before its first transaction statement. This is coalesced under bounded writer
admission, retries only on demand after a cooldown, and is owned by shutdown.
Failure starts no game transaction and mints no ready authority. It does not
block existing authoritative fallback reads.

The floor orders the new bootstrap; it does not establish that old actors have
stopped. The release additionally requires the qualified approved-writer
cutover receipt. That receipt attributes the old Render instance's SIGTERM,
uses the conservative published 300-second shutdown bound and a later actual
own-operation/causal-majority observation. It does not claim a clean-exit log
or default 30-second setting. This covers inventoried approved actors, not
arbitrary unapproved raw writes.

Old maintenance-1 source must continue retiring/recalculating authority. A
mixed writer can publish maintenance 1, which the new reader rejects. Missing
owners and standalone development contexts never qualify, and read failures
propagate rather than becoming zero. Doctor retains its profile busy/policy
errors before proof validation. Each request reads independently; there is no
extra final owner query or stronger concurrent-response linearization claim.

## Recovery

Rollback to writer-only source retains authoritative reads. Maintenance 2 does
not authorize direct resumption after Atlas/raw restore or collection
replacement: stop and settle all approved actors, retire restored derived
authority and refresh epochs, then deploy a fresh maintenance/reader version
whose bootstrap cannot trust restored tuples. Follow the database restore
runbook. In-app restore already uses exact owner/fence transactions and bounded
batches; it is distinct from raw restore.

`USER_CACHE_ENABLED` stays off. Wider dependency-safe chart coverage,
revocation-coherent device-auth reuse and the remaining roadmap requirements
are separate; this decision makes no parent-completion or savings claim.
