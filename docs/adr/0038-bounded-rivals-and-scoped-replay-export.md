# 0038: Bounded rivals and scoped replay export

Date: 2026-10-25

Status: Accepted

## Context

The opponent list already has owner-scoped replay aggregates, linked-player
identity, verified MMR pairs, notes and real dossier navigation. Rival cards need
recent context without hydrating complete dossiers or replay detail blobs. The
dossier's replay export must agree with its table and must not introduce another
CSV serializer, row-cap policy or export admission path.

## Decision

- Store at most 50 opaque grouped-player keys in the existing owner's
  `preferences.rivals` document. Match approved identities and cached account/pro
  aliases, with singleton replay IDs as a fallback; never match stars by names.
- Rank the same filtered/grouped list with 95% Wilson bounds for Nemesis and
  Favourite. Recent meeting counts are explicit input, not inferred from a
  lifetime last-seen timestamp. Ties do not become decided wins or losses.
- Read one metadata-only games facet for rival details: up to 20 recent scalar
  samples per star, at most 500 owned account IDs, and a 2,000-account sentinel
  for seven-day counts. Incomplete coverage is unavailable. A 20+ streak is a
  lower bound. Existing personal build-label corrections remain effective.
- Keep query work in process: four admitted reads, singleflight, a 256-entry
  60-second cache and per-owner invalidation fences. Replay hide/delete changes
  use the shared invalidation callback and reject late admitted results. All
  visibility markers and analyzer account filters remain in the games match.
- Derive public 30-day rating movement from raw Pulse history before its chart
  downsampling. Require actual observations within two days of each boundary;
  disclose source dates and cache age. Reuse the existing client with a shared
  512-entry six-hour cache and two cold requests; excess or absent data remains
  unknown. No poller, collection, provider budget or rating backfill is added.
- Read Live now only from fresh, existing public viewer-cache observations and
  approved cached channel aliases. This list never starts live-status provider
  calls, reads private integration credentials or treats a channel URL as live.
- Define client ownership with loaded, signed-in and user ID together. Fence
  token, body and cache-mutation awaits with current scope/controller identity.
  Real 20-second cancellation/deadline races settle held promises and allow
  retry; hidden auth-transition state cannot publish a save or CSV download.
- Use one logical 100-row presentation window, including expanded identities,
  for phone and desktop. CSV exports the complete matching sorted row set.
- Reuse the replay library's serializer, streaming response and shared
  once-per-minute owner admission for dossier CSV. Paging and export call the
  same owner/opponent/global/local/sample scope builder. A trusted server match
  only narrows the base library scope; dossier exports cap at 5,000 newest rows,
  while the library's existing 50,000 cap is unchanged. Empty or malformed
  analyzed samples never broaden to complete history.

## Consequences

Rival context is optional and can remain unknown under missing observations,
capacity or provider failure. Public movement describes the displayed primary
account rather than an average of linked players' ratings. Local list controls
and saved stars remain distinct. No production migration or backfill is needed;
the new preference is empty until the owner stars a player. Rollback is a code
revert, leaving the inert preference document readable by older deployments.
