# Wave 3 private desktop scouting checkpoint

Branch `codex/wave3-private-scouting` in isolated worktree
`C:/SC2TOOLS/.worktrees/wave3-private-scouting`, stacked on frozen installer/runtime
`ecb3035e` (dependency-only base `codex/wave3-private-scouting-deps`).

Read full final-plan specs, augments (none), audit and howto for
`agent-private-scouting-card` and dependent `agent-gui-expansion-1`.
Implementation is in progress. Root owns final dependency/main integration,
shared focus helpers and merges. Frozen chrome #684 remains clean at `11028908`.

Planned first PR: size-capped device-only current-game scouting brief plus cached
fallback and validated opponent notes; defensive plain-text scouting strip in
loading cards; scouting-only mode; private opponent note after the game; real
broker/device/controller/model/offscreen regressions and desktop-scouting help.
Expansion follows separately: local-only previews, generic placement reset and
search keyboard flow without changing controller business logic, with real Qt
focus/action tests and help/README updates.

No AI features/API calls, new infrastructure, canonical version bump, tag,
release, installer execution or signing. Do not claim live capture protection or
native install without actual platform verification.

## Durable progress

- Added bounded plain-data `agentScouting` projection (8 KiB hard cap), game-key
  and opponent guards, exact-toon dossier/note identity, and a device-only
  `device-user:<owner>` room. The broker emits only after its existing accepted
  enrichment/staleness guards; fallback reads only the current cached snapshot.
- Added device-auth cache/note routes. Notes reuse the web validator, user-scoped
  OpponentsService and invalidation; existing global API rate limits apply.
- Added enrichment provenance so an ambiguous display-name fallback cannot supply
  another account's record/tendencies to the private card. Exact-toon private notes
  remain separate. No extra Mongo query in the projection or fallback.
- Added a Qt-free defensive desktop brief parser and ScoutingStripModel, accurate
  first-meeting/unknown/full copy, UTF-16 note bounds and safe dossier paths.
- Verification: 33 API projection/route/broker/socket checks, 64 actual Mongo-backed
  bridge/enrichment/opponent integration tests, and 15 desktop model tests pass.
  API typecheck and strict new-file lint pass. Existing large modules retain their
  existing function-length warnings (zero lint errors).
- Still required: controller/socket/fallback wiring; LoadingCardModel fields and
  slim mode; Settings preference; real Qt strip and post-game note UI/persistence;
  stale-key/socket/offscreen tests; help/CHANGELOG and full affected suites. The
  following preview/reset/keyboard expansion is not implemented yet.

Frozen chrome #684 exact head `11028908` now has all GitHub web CI green (6,317
passed, 1 skipped). Latest Vercel failure is external build-rate-limit; prior
product-identical deployment was green. Root owns that integration/quota handling.
