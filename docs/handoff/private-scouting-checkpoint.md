# Wave 3 private desktop scouting checkpoint

Branch `codex/wave3-private-scouting`, isolated worktree
`C:/SC2TOOLS/.worktrees/wave3-private-scouting`. Original dependency base
`ecb3035e`; root merged the accepted dependency heads through integration #687,
main `da80e2338f60d70a90f254155a4498e8af099dc7`. Merge that main before final CI.

Read the complete final-plan specs/augments/audit/howto for
`agent-private-scouting-card` and dependent `agent-gui-expansion-1`.
The first implementation is complete; final integration/broader checks and draft
PR remain. The preview/reset/keyboard expansion is a separate following pack and
is not implemented yet. Root owns merges/shared focus helpers. Other frozen
worktrees are unchanged. No AI features/calls, new infrastructure, version bump,
tag, release, installer execution or signing.

## Implemented

- Size-capped 8 KiB plain scouting projection over accepted current-game
  enrichment, device-only room distinct from web/OBS rooms, cached device-auth
  GET and validated user-scoped note PUT. Existing API auth/rate limits apply.
- Exact canonical SC2 toon IDs (`1-S2-1-42`) come from live data or a proven
  profile resolution. Name-only matches cannot supply another account's record,
  tendencies or private note. Uploaded replay identity binds first-meeting notes.
- Defensive Qt-free parser/model, safe dossier paths, actual sample counts,
  separate unknown-history/first-meeting copy and bounded UTF-16 notes.
- Socket/fallback/runner/actor wiring, stale-key guards and single-flight bounded
  fallback. A local scouting flag preserves the three-boolean cloud preference
  contract. Global check-in enable still gates automatic cards. Slim cards need
  an actual brief; user dismissal never reopens on a later brief.
- Plain-text 320px strip survives locked loading cards. Post-game private note
  accordion saves separately from check-in notes, preserves drafts and retries,
  requires synced replay identity, and bounds notes to 500 UTF-16 units.
- Desktop-scouting help, related links, README and Unreleased CHANGELOG entries.

## Verification checkpoint

- 330 affected native/actor/model/transport/legacy check-in/wiring tests pass,
  including actual Qt editing/actions, elision, capture-exclusion request and
  retained non-activation flags/no explicit activation calls.
- 38 latest API projection/enrichment tests pass after discovering the real
  profile-only live payload and canonical toon-ID format. Before that correction,
  33 focused + 64 actual Mongo-backed API bridge/socket/opponent checks passed.
  Re-run the combined affected API suite after main integration.
- API typecheck and strict new-file lint pass. Existing large API modules keep
  their baseline function-length warnings (zero errors).
- Full agent/API checks, help registry/type checks, screenshots and draft PR
  remain required. No native capture/foreground guarantee is claimed: Qt's
  offscreen backend ignores these native flags on the frozen baseline too.
  Representative post-game geometry is 360x475 collapsed, 360x671 with More,
  and 360x397 with the private note open (pickers hide while editing).

## Next pack

Implement `agent-gui-expansion-1` on a separate isolated dependency branch:
local-only previews with no controller/API mutation; generic saved-position
reset; Cards settings controls; search Enter/Down/Up/Ctrl+Enter behavior; actual
Qt preview/reset/keyboard tests and help/README updates. Do not change controller
business logic in that pack. Final release/tag remains coordinated by root/owner.
