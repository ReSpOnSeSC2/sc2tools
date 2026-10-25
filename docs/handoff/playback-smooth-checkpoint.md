# Recorded playback guidance and smooth segments

Implements `accurate-playback-smooth` on `codex/wave3-playback-smooth`. This reuses the clean `wave3-owner-neighbors` worktree after the neighbor API was integrated elsewhere; the original `codex/wave3-owner-neighbors` branch and its committed head remain preserved. No native source, capture setting, production account or replay was changed.

The playback card shows Standard/Recorded playback, cached desktop presence, typed request/recording/upload/ready phases and elapsed recording time. Static CPU/setup copy lives in a disclosure outside live regions. The canvas accuracy link is at least 12px and focuses/opens the same disclosure, with a Help fallback for standalone viewers. Upgrade/Retry use shared Buttons.

Segment reads have independent abort controllers for the foreground and one neighbor prefetch. Forward prefetch begins within max(8, 3×speed) seconds of a boundary; backward seeks can prefetch the prior section. A 24 MB LRU uses conservative decoded-object accounting rather than wire size or entry count. Cached switches do not buffer. A miss keeps the mounted canvas's last frame and shows a corner status; initial loads/errors retain full loading/retry UI. The small merged cast-marker presentation index survives detailed segment eviction and is scoped to the user/game/artifact.

Verified artifact completion can notify the owner through the existing idempotent private bell service. The website request identity is copied into the upload marker when an active recording request exists, then retained on the published artifact. A stable delivery key prevents repeated completion or viewer polling from duplicating notifications. Automatic uploads do not notify. Successful authenticated content-addressed segment responses use `private, max-age=604800, immutable`; manifests/errors remain no-store.

## Validation before integration

- 104 assertions in 11 replay/controller/segment/HUD/quality suites pass, including forward prefetch, aborting obsolete reads, no cached-transition overlay, last-frame status, markers and shared disclosure focus.
- 22 local API tests across artifact completion and recording route suites pass. The notification test uses real temporary Mongo with mocked object storage, verifies exactly one stored delivery across repeated completion/reads and none for automatic uploads. Full API types and strict changed helper/router/test lint pass.
- Web types passed before the final small test/Help additions; final types/lint, required production build/budgets, independent source review and responsive browser proof remain required. Help index must be regenerated after final integration.

No AI features/API calls, new infrastructure, bundle-budget increases, production migrations, recording runs, integration enablement, signing, installer execution, version bump or release tags.
