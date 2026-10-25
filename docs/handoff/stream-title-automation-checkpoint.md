# Wave 4 desktop stream-title automation

Worktree: `C:/SC2TOOLS/.worktrees/wave4-stream-titles`, branch
`codex/wave4-stream-titles`. Human authorization in the 2026-10-24 continuation
explicitly resolves the earlier approval hold for optional publication of
selected stats to linked Twitch/Kick/YouTube accounts. Implementation and
verification use mocked provider calls; no actual account publication occurs.

## Implemented

- Streams accepts `{mmr}`, `{league}`, `{record}`, `{wins}`, `{losses}`,
  `{streak}`, `{peak}` and all nine `{wr:PvZ}` variants. Live native preview
  updates while typing; private preview-refresh never publishes. Entire
  missing/overflow optional `|` segments are dropped. The existing shared
  1-70-character validator still owns rendered titles.
- Automatic titles default off. Twitch/Kick are selected initially; YouTube
  is not. Strict saved switches and the template are bound to the API/token
  fingerprint. Account/mode changes disable consent. No new credential storage.
- Both runtime paths subscribe to real game-end events and wait for accepted
  live replay sync. Replay viewing, history and resumed branches are excluded.
  The independent worker never holds the upload/lifecycle lock for slow work.
- Requests are at most ten minutes apart; unchanged titles skip per platform.
  Attempt receipts are saved atomically before provider calls, preventing
  ambiguous writes from repeating after restart. Existing verified,
  accepted-offline and unconfirmed platform receipts remain distinct.
- Account-bound cloud clients fence pending writes on shutdown and local mode.
  YouTube metadata temporarily uses that bound client through the existing
  tracked-session backend.
- Owner-only `GET /v1/agent/streaming/session` reuses `todaySession` and one
  indexed, projected, 2-second-capped, 512-row ladder-history read over 90 days.
  No detail hydration or aggregation. League comes from the same existing Pulse
  result as session MMR without another request. Peak uses one character/race
  in the session region; matchup rates describe bounded recorded history.
- Help article `desktop-stream-titles`, inline token reference, README,
  agent/root changelogs and owner setup notes document the complete behavior.

## Verification before main integration

- Initial native focused run: **142 passed**. Final controller/UI run after
  adding preview controls: **49 passed**.
- API unit/service/real-Mongo owner integration suites: **52 passed**. All
  provider calls are mocked or forbidden; no production credential is loaded.
- Full API types and strict lint of changed route/new session sources pass.
  Existing games.js function-size warnings predate this change.
- Help import boundary: **2 passed**; regenerated Help index has 72 articles.

Main integration, broader native/package verification, final Help/build checks,
independent review and PR/CI evidence remain required at this checkpoint.
No release version, signing, tag, production migration or actual streaming
account change has been performed.
