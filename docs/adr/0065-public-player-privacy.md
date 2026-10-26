# ADR 0065: Explicit public player consent and canonical addresses

Status: Implemented in source; verification and delivery pending.

## Consent wins over discovery and caching

The player page, published Community builds and shared replay archive are
separate publication surfaces. Named Community publications grandfather an
existing profile only while the owner has never saved public-profile settings.
Once settings exist, explicit `enabled: false` hides the profile even if those
builds remain published. It neither removes those builds nor disables the
archive. New optional profile sections default off.

This tightens the older roadmap's literal “enabled OR legacy publication” rule:
an Off switch must actually revoke profile visibility. Archive and analysis DTOs
carry a profile capability only after a current profile gate passes. Published
build author chips likewise use a current `authorProfileHandle`; a private owner
identifier never creates a client-side profile link. Profile-to-archive links
require both archive sharing and the profile's separate `showReplays` choice.

## One address authority

`replaySharing.slug` and its existing unique index own the canonical namespace.
Normalized public-profile settings derive their address from it rather than
maintaining a second writable slug authority. The readable prefix is editable;
the server-owned random suffix stays fixed. A rename has a 30-day cooldown and
requires the owner to turn an active archive off first. Renamed addresses are
not retained as aliases in this pack.

Previously public named-build profiles without an address may receive only a
bounded, idempotent address compatibility repair after the public legacy gate
passes. The repair rechecks admission, never enables the profile, archive or
new sections, and does not run as a bulk migration. Private, unknown and
archive-only records do not get a profile address from that path.

## Fresh admission takes priority over the planned ISR and CDN TTLs

The roadmap proposed ISR300 pages and one-hour shared image caching. A cached
personal page or bitmap could outlive an explicit Off choice. Player pages,
metadata, legacy redirect admission and image HTTP responses therefore use
fresh no-store reads. React request memoization deduplicates metadata/page work
inside one request only. The API may cache bounded aggregates for five minutes
only behind a fresh consent/name lookup.

Community list/detail DTOs can also carry a current author-profile capability.
Their decorated HTTP responses, Next data reads, pages and Community social
images stay no-store even with an optional purge service configured. A failed
purge cannot preserve a profile link after Off. Internal published-content
caches and unrelated pure guide/review caches keep their existing policies;
current capabilities are decorated only after the content cache lookup.

The legacy Community sitemap keeps only cached published-build URLs with an
empty `profiles` array and skips the unused legacy UUID aggregation. Canonical
profile discovery comes solely from the fresh no-store players sitemap. The
web sitemap has no output cache while unrelated list contributions retain
their existing bounded data caches.

Channel images also admit the current profile before a bounded server bitmap
cache. That cache lasts at most one hour, holds at most 48 entries and 8 MiB,
and contains only selected public-card bytes keyed by a hash. CDN caching never
bypasses admission. Disabled, missing, archive-only and unavailable profiles use
the same neutral image data without identity, MMR or record values.

The player and legacy author redirect segments intentionally have no loading
route or ancestor that can flush HTTP200 before authoritative admission. A
real404 is neutral missing/private;429,5xx,
malformed successful responses and timeouts remain temporary errors. This
preserves the existing public status-boundary contract.

Community's directory index keeps its original loader inside an index-only
`(directory)` route group. It cannot wrap the legacy author redirect; child
build and opponent skeletons retain their existing routes and behavior.

## Data boundaries and operational effects

Public signature-build aggregates use the detector view of recorded replays.
Private planned selections cannot replace replay-detected labels in this
public projection. Published Community builds remain separate public content.

The canonical Builds tab reuses the author browser's sorting, matchup filters
and title/description search. Its DTO selects only slug, title, matchup, votes,
an already-public description capped at4,000 characters and normalized public
dates; it excludes owner identity, private snapshots and anonymous publications.
The existing slim author query projects that bounded description before reading
rows into the application. Source100/final50 row bounds and query deadlines do
not change; counts and the displayed cohort are described as recent samples,
not exact lifetime publication totals.
Browser rows are attached freshly from author metadata already read for each
admission. Description-bearing rows never enter the long-lived aggregate cache,
so a changed description is immediate without a new database read, aggregate
rebuild or up-to256 copies of the description cohort. Other metric cache keys
and invalidation semantics remain unchanged.

Recent form reconstructs only result, race matchup and date. Opponent names,
IDs, maps and raw game rows never enter that section. Streak and last-played
data share the same explicit section switch. Approved channel links use the
public directory, never provider grants. Optional map records require ten games;
season records use a cached catalog and report unavailable data honestly.

No infrastructure, integration enablement, migration execution, AI calls,
release version or installer is part of this pack. Deploy API before web;
rollback web first. Public-profile preferences reside on the users row, which
the existing account export/erasure includes. Restoring a snapshot must not
restore publication consent or a historical public address.
