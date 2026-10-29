# Macro revision carry: source candidate

Based on passed main `e84cd77397033a5c46c5fcb2bfd936b42f499950`, on
`codex/game-revision-carry`. This prerequisite is locally verified; publication
and exact-head CI/deployment/live gates remain pending. No release or retained
cache activation is claimed.

Only macro-score/top-three-leak recomputes gain a named count-neutral operation.
Its copied descriptor and owner stay fixed across awaits/retries; the operation
owns the original live-game filter, allowed fields and explicit no-upsert.
Owner-first claim and final publication share the existing admitted transaction
and session. Strict ready protocol-2/maintenance-2 preimage statistics carry to
the new UUID without count/latest queries. Invalid/old/unsupported proof is
retired, preserving authoritative reader fallback. Existing eager ingest/wipe
semantics, exact Mongo eligibility/date handling, advisory invalidation and
post-commit detail-store order remain unchanged.

New tests cover immutable payload/authority, carry versus retirement, finite
admission/drain, real session/majority commands, two-client ingest concurrency,
transient/unknown outcomes, owner/fence/epoch changes and composed sessions.
Original tests remain unchanged. The composition test proves same-session/no-nesting only;
future production callers still need admitted floor/drain ownership and fixed
inputs across their outer retries. Other non-count families, broader chart coverage and any fleet
cutover remain unfinished. No expanded coverage marker, reader activation,
flag, migration, provider, engine or native change is included.
`USER_CACHE_ENABLED` remains off; the roadmap ledger is untouched.

## Local verification

One current in-band run passes all 349 cases across 14 files, zero failures or
skips, including the new two-client replica-set tests and unchanged macro
persistence/standalone compatibility consumers. Mongo 7.0.14 was cached,
downloads disabled, and instances ran sequentially. Actual command assertions
prove the owner-first snapshot/causal floor, shared session, majority/journal
commit and zero count/latest reads on carry or retirement. Real standalone
fixtures use the unchanged connected-topology check and cannot mint a tuple.
Whole-API types and strict owned lint pass with no added baseline warnings;
all three new JavaScript files pass strict complexity/function checks.

The first run's three new-fixture failures are retained: monitoring needed the
existing silent-logger option, and Jest's row arrays needed object wrappers.
All assertions remained. Two declaration errors and new complexity findings
were fixed with typed annotations and independently reviewed cohesive helpers;
the final full run follows those runtime changes. Mongo teardown warnings and
the initial canonical-versus-raw guard failure remain preserved in cache.

All 1,007 API inputs stayed exact within each command. Forty canonical inputs,
seven served assets and sample/availability raw hashes remain unchanged.
Exact PID/executable/UTC settlement covers 34 observed identities with zero
owned/unknown processes or listeners and no kills. Evidence is under
`.cache/game-revision-carry-20261028/`. This checkpoint prose follows the
runtime checks; application/test bytes are unchanged. No build/browser,
production/provider call, flag or roadmap-count change is included.
