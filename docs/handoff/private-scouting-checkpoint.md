# Wave 3 private desktop scouting checkpoint

Branch `codex/wave3-private-scouting`, isolated worktree
`C:/SC2TOOLS/.worktrees/wave3-private-scouting`. Original dependency base
`ecb3035e`; root merged the accepted dependency heads through integration #687,
main `da80e2338f60d70a90f254155a4498e8af099dc7`, merged cleanly at `5ea17640`.

Read the complete final-plan specs/augments/audit/howto for
`agent-private-scouting-card` and dependent `agent-gui-expansion-1`.
The first implementation, integration and local checks are complete. Draft PR
and remote CI follow. The preview/reset/keyboard expansion is a separate following pack and
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

- Final integrated full agent suite: **2,131 passed, 1 platform skip, 78
  subtests** (158.93 s). Includes 20 latest native/actor checks for realistic
  font metrics and preventing a cached note crossing resolved account identity.
- Integrated API projection/cache/auth/socket privacy/broker/enrichment/opponent
  notes suite: **82 passed**. Both API and web typecheck pass. New API files and
  touched help leaves have strict lint with zero warnings; existing large API
  modules retain baseline function-length warnings (zero errors).
- All help registry/links/content/search checks: **72 passed**, 70 articles.
- Real unsigned PyInstaller one-folder bundle built successfully. Its PYZ table
  includes the new scouting model/actor/UI modules. The frozen offline GUI
  diagnostic reports success with Qt 6.12.0, all five pages and Streams painted.
  This diagnostic does not initialize user state, pairing, replay services or OBS.
- Three actual offscreen screenshots with sample data and installed Segoe UI font
  registered are in `docs/handoff/screenshots/desktop-private-scouting-*.png`.
  Loading full 320x353, slim 320x210, private note expanded 360x380. The native
  regressions verify plain-text elision, separate notes, retries, capture-exclusion
  requests, retained non-activation flags and no explicit activation calls.
- No native capture/foreground guarantee is claimed: Qt's offscreen backend ignores
  these native flags on the frozen baseline too. No installer was executed or
  published, and no version bump, signature or release was requested.
- Exact-CI web production build and every unchanged bundle budget pass, including
  /help 151.2/185 kB and /help/[slug] 179.4/200 kB.

## Next pack

Implement `agent-gui-expansion-1` on a separate isolated dependency branch:
local-only previews with no controller/API mutation; generic saved-position
reset; Cards settings controls; search Enter/Down/Up/Ctrl+Enter behavior; actual
Qt preview/reset/keyboard tests and help/README updates. Do not change controller
business logic in that pack. Final release/tag remains coordinated by root/owner.

## Final main integration for #691

Green main `b86ca989` (ops #689 and header/Community #690) merged cleanly at
`9a3467fe`. Both the shared wrapped auth and audit middleware remain in the
additive route mount. A new real HTTP/device/Mongo regression proves that a
private note retains schema version 1, uses the GDPR write fence (409 during
erasure), preserves another owner's note, and cannot be read or recreated after
erasure (401). Combined privacy/broker/socket/enrichment/notes/erasure/schema/
collection-classification/ops checks: **133 passed across 12 suites**. API types
and touched lint pass with baseline large-function warnings only. No agent source
changed in this main integration, so the full native/package evidence above
remains applicable. Root owns remote final CI/preview quota and merge.
