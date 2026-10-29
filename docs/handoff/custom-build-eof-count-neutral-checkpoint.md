# Custom-build EOF revision: source preparation

This source-only slice starts at the preserved Pulse integration
`c06746224d496f9814bc2fb33f298612fe7bb2ca`. It covers only the successful
single-build and all-build reclassification EOF commits. Rename, ingest,
definition edits, staging, cleanup and notifications retain their existing
paths. No release or runtime verification is claimed yet.

The original EOF pipeline has one pure implementation, reexported by
`customBuilds`. The closed server descriptor accepts a run UUID, sequence,
mode and the existing job lease or captured custom-build repair fence. It
cannot accept a callback, query, pipeline, update, membership/date field or
upsert choice. Run data and owner identity are copied before library scans
or replay hydration. Provider and scan work remain outside transaction retries.

One admitted causal transaction claims the exact owner, publishes the entire
EOF update and rotates its statistics UUID. An already strict protocol-2,
maintenance-2 count/latest tuple is carried from that atomic preimage; an
invalid tuple stays retired without a recount. This is count proof only and
does not establish expanded chart coverage. The whole EOF is never chunked or
retried through a nontransactional fallback if a transaction limit is reached.

Ordinary work requires the captured owner incarnation/epoch and an absent
destructive fence. The existing custom-build repair delegates its original
`fence.owner` and `fence.id`, without recapturing under the active fence. Its
EOF authority additionally requires that exact ID, matching owner epoch and
the fixed `repair_custom-builds` kind. Other named families and generic
callback authority are unchanged; GDPR acquisition, renewal and release are
unchanged.

All-mode EOF repeats the active opponent-write guard after added awaits and
renews the exact existing job generation/token/running predicate in the same
session. Its original lease callback checks remain. Native cancellation is
checked after new waits and before dispatch; cancellation cannot undo an
already committed write. Known transaction abort rolls back the full EOF,
lease renewal and owner revision. An unknown commit outcome is propagated,
with no invented success or repeated external hydration.

New source tests cover closed descriptor/authority validation, native signal
branding, copied data across held waits, actual single/all consumers, original
marker/override/sequence behavior, same-session commands, captured repair
delegation and rejection of stale/foreign fences, rollback, transaction retry,
lost acknowledgement, concurrent ingest and drain ownership. Original tests
and assertions are unchanged. Tests, API types and lint are pending independent
source review and a separate admitted runtime lane.

The faster-dashboards parent remains partial. The ledger remains 197 items:
124 completed, 53 partial, 20 open and 73 remaining. No cache flag, dependency,
asset, provider or production state changes are part of this slice.
