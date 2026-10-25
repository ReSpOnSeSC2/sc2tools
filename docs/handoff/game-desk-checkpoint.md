# Dock Game desk checkpoint

2026-10-25. Branch `codex/wave4-dock-game-desk`, based on actual main through
`af68351e` (728). The merged Dock foundation and stream-safe Scout predecessor
are preserved. ADR0039 and `plan/owner-setup.md` describe the storage and rollout.

## Result

Game is the first Dock section. Its sticky header keeps scene/countdown,
connection, current public opponent, session record/MMR and counts-only source
presence visible. The measured header controls jump/scroll offsets. Desktop
chat fills the left column beside the leading Game/Scout controls; pinning still
preserves panel drafts. Small status text and active jump tabs pass contrast.

The Game panel shows bounded active match facts, Crystal Ball tally/lock and
explicit confirmation for cancel/manual result/session reset. Manual/cancelled
results never award points or oracle accuracy. An observed ended-game receipt
survives the native return to menu for 30 minutes, clears on a new active/replay
game and cannot be renewed by delayed same-key ended frames. Approved exact
Pulse/toon channels support queued Twitch shout-outs or selected manual copy;
no name/provider fallback supplies a channel.

Session resets use the owner's monotonic anchor, committed token stream-start
mark, resolver invalidation and client epoch guards. Verified awards use a
durable per-token lane plus one scalar receipt per viewer, recover after partial
failure, serialize successive lanes and suppress late older reveals in both the
real widget and bot. Token rotation admission remains around those writes.

Hide game widgets saves one strict boolean in existing Studio state. Refreshed
game sources and scouting voice wait for/replay that state over their existing
socket. Chat, scenes, polls and timers continue. No extra socket, periodic server
aggregation, collection, index, migration, environment variable or account
activation was introduced.

Current native live envelopes omit the map, so the UI says **Map unavailable
live**. It accepts an actual bounded map if supplied; it never uses the prior
replay's map. Old Browser Sources must be refreshed once after the API/web deploy
to receive pause/manual-result behavior. No native release is required.

## Evidence

- Broader affected web/Help run: 861 passing tests. Final affected Dock/menu
  consumers: 33 passing tests; full web types and strict changed-consumer lint.
- Broader API proof: 164 affected service cases and 121 existing Studio/router
  cases passed. Final recovery/ended/channel/session/bot selection: 127 passing
  cases, plus API types and strict new-helper lint. Token/scoring integration
  also passed 78 cases. Counts overlap and are not a single cumulative suite.
- Failure/concurrency tests hold viewer awards, leaders reads, session writes and
  old owner callbacks. They cover durable resume, successive pending lanes,
  reversed reset completion, post-rotation denial and late closed-round reveal.
- Browser engine built and smoked: `604e9d4618a6414b`, engine1.6.12,
  Python3.14.2. Next production build uses the repository CI public placeholder;
  production budgets remain unchanged. Dock214.6/225kB, Today238.9/240,
  landing214.7/215, game317.1/440, opponent476.1/500.
- Help regenerated84 articles with no content diff. Stream Dock, Viewer
  engagement, Learn pages and Crash Course lesson5 explain the controls and
  fair-play limits.
- The real production Next Dock route passed3 viewport checks (300/768/1440),
  including retained drafts and an actual rejected optional chunk followed by
  successful Retry. These use synthetic API routes and block socket traffic.

The repeatable manual harness is `apps/web/tests/manual/game-desk.cjs` with its
explicit boundary bundle. It mounts real Dock and OverlayWidgetClient consumers
against actual local Socket.IO and real GameDeskService with disposable
in-memory persistence/provider adapters. All browser requests are restricted to
the dynamically allocated loopback origin; no real provider post, account or
production database is involved.

The matrix covers300/320/390/768/1440px, light/dark, production CSS/fonts,
475 checks and24 captures: active facts, desktop/pinned geometry, sticky jump
offsets, coarse-pointer hit targets, axe checks, copy fallback, actual source
pause/resume, menu manual reveal, missing/expired/verified gates, cancel, session
reset, busy-dialog focus through Escape/backdrop and old-token response fences.

Screenshots use only the `game-desk-*.png` prefix. Representative review targets:

- `screenshots/game-desk-active-light-300.png`
- `screenshots/game-desk-active-dark-1440.png`
- `screenshots/game-desk-shoutout-dark-300.png`
- `screenshots/game-desk-busy-dark-300.png`
- `screenshots/game-desk-manual-oracle-light-1440.png`

Independent API review findings (award recovery, reversed reset and late reveal)
were corrected and re-reviewed clear. Parent source/visual signoff and final
expected-head CI remain required before squash merge. Vercel's account-wide
24-hour deployment quota was affecting other PRs at this checkpoint; inspect
the actual check without redeploy loops.
