# OBS game overlay / confirmed website sources

Source worktree: `.worktrees/wave3-guides-expansion`; branch
`codex/wave4-obs-game-overlay`. The original map-veto branch is preserved.
Reviewed runtime includes fresh main `b2abc9c0`, Health `19136bd2` and its
test-only catalog correction `029c1cbd`. OBS source is preserved through
`ca50a7cc`; later commits add integration/test/evidence only.

## Behavior

- Build defaults to a canvas-sized all-in-one source between webcam and
  cover/alerts, with a credit choice. Ghost, Randomizer and the 1920×56 ticker
  are optional. Ghost visibly requires its assigned URL before coaching.
- Update adds only selected missing sources. Same-token routes reuse a Browser
  renderer, and existing items/settings/relative order stay intact. New items
  start disabled until placement finishes.
- Private website Add targets one authenticated opted-in device. Default is off;
  every request requires a default-Cancel local dialog naming the program scene.
  Owner/socket provenance, expiry and current scene are checked after slow reads
  and again before showing the source. A failed setup can leave a disabled source
  for inspection; an uncertain ACK is never retried automatically.
- Ghost website Add remains disabled/rejected because its assigned private URL
  fragment is not part of the widget-only command. Copy/Drag remains available.
- Availability is shared across cards. Cloud admission is one pending request
  per owner, 64 total, with bounded inventory/ACK deadlines. No replay query,
  aggregate, new infrastructure, index or persistent collection is introduced.

## Validation

- Full web suite: 7,292 passed, one existing skip. Combined Health/OBS settings
  and Help slice: 270 passed; corrected shared guide-catalog fixture: 8 passed.
- Native CI core partition: 2,578 passed, one platform skip, 78 subtests.
  Final affected native slice: 176 passed, followed by 93 including the closing
  socket-loop race. All five existing minimum-width/OBS UI tests pass at 1×/1.5×.
  The broad combined run exposed the new long-checkbox width issue, now fixed;
  its unrelated child-import failure passes unchanged from CI's `apps/agent` cwd.
- Combined API/socket/Health slice: 58 passed. API/web types and scoped lint pass.
- Required engine prebuild/smoke completed with unchanged hash
  `604e9d4618a6414b`; final combined production compile passes every unchanged
  budget: landing 214.5/215, app 228.3/240, opponent 475.9/500, settings 179.5/260,
  Dock 218.5/225, overlay 234.2/240, standalone widget 314.7/325 kB.
- Actual Chromium: 224 checks, 17 captures, 320/390/768/1440 in both themes,
  real settings/chrome/Health/Profile components and production CSS. Explicit
  synthetic Next/auth/API boundaries; all nonlocal traffic blocked. Covers
  no-fanout availability, pointer targets, offline/default-off reasons, native
  outcomes, device selection, real polling, held token/body owner transitions,
  ready-state recovery, Ghost guidance and overflow.
- Four readable offscreen Qt captures show both builder heights, the exact
  named-scene default-Cancel prompt, and default-off settings at minimum width.

No real OBS connection, account integration, installer execution, signing,
release, tag, version bump, migration or production action was performed.
Native support will ship through a future ordinary agent update; older agents
retain Copy/Drag and explain why website Add is unavailable.

ADR: `docs/adr/0037-confirmed-obs-game-sources.md`. How-to:
`docs/obs-auto-scene-switching.md` §§5/7, Help `obs-auto-scene-switching`, and the
crash course's **Let the app build it** step. Exact final CI head and merge
evidence belong in the PR body, avoiding documentation-only CI restarts.
