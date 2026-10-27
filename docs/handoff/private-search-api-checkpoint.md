# Private quick search API — 2026-10-27

This is the API portion of Find anything. Deploy and verify this backend before
publishing the private search interface. The interface and its user-facing Help
and changelog are a separate release. No desktop-agent version or tag is needed.

## Behavior

Authenticated `POST /v1/search/quick` accepts only `{q}`. Input has 2–80 Unicode
code points after outer trimming; controls and unpaired surrogates are rejected
before trimming. Prefix matching is literal, escaped and case-insensitive.

The version2 response has independent opponents, customBuilds and maps groups.
Ready groups return up to eight typed results and `hasMore`; unavailable groups
return no partial rows, a fixed reason and `hasMore:null`. Maps are explicitly
deferred in application configuration. Opponent names rank by last meeting;
custom builds rank by last update, with unknown dates last and stable ID ties.

The owner-only source scan is sorted by `_id` and capped at4097 documents before
eligibility or prefix filters. Libraries through4096 source rows can complete;
larger libraries return unavailable. All nine discovered candidates, including
the pagination sentinel, receive fresh selected-ID publication checks. Fresh
user, identity-tombstone and GDPR checks precede and follow the search. These
are bounded read points, not a multi-collection atomic snapshot or a guarantee
that ordinary edits cannot race an in-flight response.

## Privacy, capacity and index rollout

- Strict1KiB JSON parsing follows IP admission and precedes one route-auth pass.
  Exact rejected methods skip JSON parsing and return405. Existing large replay
  and coaching admission remains unchanged.
- Every exact-path status is private/no-store. Successful JSON is byte-bounded
  and sent without an ETag or304 branch. No completed cache or in-flight join.
- Private query parameters are removed from operational and report-request
  paths. SDK HTTP body capture/incoming tracing is excluded; request-local
  scope and whole-event guards suppress private telemetry. Mongo failures are
  code-only for private or unknown command metadata.
- Two active searches per process, one per owner, no waiting queue;60 attempts
  per minute per owner with4096 bounded rate buckets. This excludes preexisting
  authentication work and is not a distributed quota. Permits survive outward
  timeout until actual reads/cleanup settle; uncertain cursor cleanup quarantines
  the lane until restart.
- Original facet BSON and final JSON each have separate64KiB limits. Native
  reads use primary preference, maxTimeMS300 and a supported300ms cursor-lifetime
  deadline including exhaustion. All native cursor closes must complete.
- Exactly one new nonunique opponent index ships: `{userId:1,_id:1}`, simple
  collation, stable name `b2_probe_owner_id_v1`. It builds without holding boot,
  separately from guide readiness. Building/failed/missing access paths return
  an unavailable opponent group without scanning a fallback or hiding builds.
  Custom builds reuse their existing catalog index. No new game index ships.

Normal authenticator identity creation/device liveness remains preexisting
behavior. Search itself acquires no mutation lease and writes no user revision,
session policy, private corpus or repair data. No provider settings, service,
tier, feature flag or environment variable is added.

## Validation and remaining release gates

Final local API slice:173 tests/13 suites, including18 actual app/Clerk-fixture
and device-auth HTTP cases, actual reader/BSON/point-plan checks, no304, owner
isolation, read-only existing-owner snapshots, GDPR/tombstones, missing-index
group isolation, and guide/search background-readiness regressions. Whole API
types pass. Lint has no errors/new diagnostics; seven legacy function-length
warnings are explicitly matched to released99bf0865 source without suppressions.

The isolated A05/B05 experiments completed296 logical probes/148 original BSON
reads and oracle comparisons, with exact cursor exhaustion, source/key/disk
bounds and graceful database closure. Independent review retained1430 raw hashes.
Earlier failed trials remain failed; the final measurements do not reclassify
them. Synthetic index sizes are evidence for those fixtures, not a production
storage forecast, billing guarantee or live performance/SLO claim.

Exact-head CI, merge and actual API deployment acceptance remain separate gates.
Keep the interface unpublished until the new endpoint is live. For rollback,
retire its interface first and retain fixed-path privacy protections for cached
clients. Do not automatically drop the additive nonunique index.
