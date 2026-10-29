# Custom-build EOF revision: local verification, release pending

This source-only slice starts at the preserved Pulse integration
`c06746224d496f9814bc2fb33f298612fe7bb2ca`. It covers only the successful
single-build and all-build reclassification EOF commits. Rename, ingest,
definition edits, staging, cleanup and notifications retain their existing
paths. Local verification is recorded below; this EOF slice still requires its own exact-head CI and release acceptance.

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
lost acknowledgement, concurrent ingest and drain ownership. Existing assertion values and forwarding remain unchanged. Two MemorySafety EOF interception blocks use the actual DbContext.games seam. The admitted local gate is recorded below.

The integrated local gate passed 801 tests in 37 deduplicated API files,
including 53 new EOF cases, whole-API types and configured scoped lint. Four
new files are strict-clean; five changed legacy files add no diagnostics.
Jest ran in band with the cached MongoDB 7.0.14 binary and downloads disabled.
All three current child and wrapper exits were zero. Three captures of 1,041
API inputs and 49 raw assets stayed exact; final filesystem guards rehashed
7,029 source files and 126 source/dependency/asset rows without drift.

The first integrated gate stopped at types with TS2353 before lint or tests.
Its child exit 2, wrapper exit 1 and two-identity cleanup remain retained.
Only three optional service declaration fields were aligned with the existing
runtime JSDoc. No runtime, assertion, rule, deadline or test skip changed.
Mongo shutdown ECONNRESET warnings remain in the raw successful-run log.

Final scoped settlement covered 44 exact identities and retained four
incomplete historical observations. Its fresh global query found no current
candidate, orphan or listener; no process was killed. The scoped receipt does
not store the complete final global census. This is current absence evidence,
not retrospective ownership or continuous observation.

The tested source was e72772c9 plus the approved types-only change. Commit
1b5c0ad7 preserved that change; normal integration of delivered main 4cc33ba2
produced clean 19d21fd2 with tree
2b4f7ce6679b8ddfac9a1d12af91a1952ed003da. All 1,041 API inputs, 3,537 web
inputs, 7,029 full-source bytes, dependencies and protected assets remained
exact. These documentation changes follow those guards. No new web build or
browser result is claimed: the web tree is the exact delivered PR818 tree.

The [compact local receipt](validation/custom-build-eof-count-neutral/local-verification.json)
links the immutable source, current results and post-gate integration proof.
EOF exact-published-head CI, deployment and relevant acceptance remain pending.
PR818 delivery and the approved unsigned Agent publication are separate proof.

The faster-dashboards parent remains partial. The ledger remains 197 items:
124 completed, 53 partial, 20 open and 73 remaining. No cache flag, dependency,
asset, provider or production state changes are part of this slice.
