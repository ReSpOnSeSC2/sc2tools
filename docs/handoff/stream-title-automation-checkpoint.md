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

## Final integration and verification

- Integrated current main through PR700 (`7464cecd`), preserving current
  Companion/upload/Streams account fences and all changelog/Help entries.
- Initial native focused run: **142 passed**; integrated account/service/UI
  cases: **115 passed**; final controller/account/worker cases: **34 passed**;
  controller/packaging-diagnostic source cases: **24 passed**.
- API/session/real-Mongo ownership integration suites: **137 passed**. All
  provider calls are mocked or forbidden; no production credential is loaded.
- Full API types and strict lint of changed route/new session sources pass.
  Existing games.js function-size warnings predate this change.
- Full web types and strict Help lint pass. All **77 Help tests** pass;
  regenerated index has 75 articles and regenerates without changes.
- Final integrated production build and every unchanged bundle budget pass:
  landing 213.6/215 kB; /app 235.2/240; game 313.4/440; opponent 493.2/500;
  Help 151.4/185 and article 179.6/200. Logs: apps/web/.tmp-title-web-*-integrated.log.
- Actual unsigned package built with the current packaging script's sanitized
  Windows/runtime PATH. The complete Qt6.12 offscreen diagnostic passes,
  including title preview/default-off/YouTube-unselected controls and existing
  six pages/Companion/pinned panels. Twelve compiled modules matched source.
  Proofs: apps/agent/.tmp/title-frozen-clean.json and title-modules-proof-clean.json.
- Styled sample screenshots inspected at 1120x900 and 820x600; no horizontal
  overflow. Reproduce with apps/agent/tests/manual/stream_titles_preview.py.
- Root review fixes actual stored Victory/Defeat/Tie matchup normalization and
  per-platform durable attempt marking. Failed YouTube setup does not suppress
  untouched Twitch/Kick attempts. Account changes also clear queued old games
  before a new account may explicitly opt in.
- Accepted live replay receipts can arrive before the lifecycle end poll.
  Four fresh timestamp-matched receipts cover either ordering; consumed receipts
  cannot rearm a game. History/resumed/unrelated/stale receipts are excluded.
  Reset and restart discard queued receipts, with deterministic regressions.

PR703 is created/attached and initially pushed at `e6c9be4f`. Final CI is running;
the local full native suite is progressing through current main's expanded GUI
coverage. Final results belong in the PR body before merge. Coordinate merge
after Studio702; root changelog entries use separate insertion points. This is
one completed implementation pack, not completion of the wider roadmap.
No release version, signing, tag, production migration or actual streaming
account change has been performed.
