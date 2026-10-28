# ADR 0059: Intent-loaded browser replay demo

Status: accepted; browser implementation delivered, server-retirement candidate unverified

The Wave 5 `landing-demo-in-browser` pack moves the home-page one-replay build editor demo onto the existing Instant Analysis runtime when `NEXT_PUBLIC_INSTANT_IMPORT=all`. This changes source behavior behind the existing build-time flag; it changes no environment, rollout setting, release or production data.

The small landing card loads the browser session component only after actual hover, focus, file drag or file selection. That intent starts the existing worker warm-up; ordinary page views neither create a worker nor download its engine. The session uses one file, 1v1 only, all dates, no digests and no policy refresh. It reuses the worker's bounded reads, parse deadlines, cancellation, player chooser and shared error copy. There is no upload, account write, local report persistence or API fallback from this path.

A narrow pure projection converts the selected player's payload into the existing demo dossier. It keeps both complete build logs, recorded map/duration/date/results and replay player identity. The chooser provides the selected name; an automatic path without a name hint says "You". Malformed payloads fail visibly rather than becoming invented results. The selected side opens immediately. Closing the editor exposes two accessible player choices in the landing card; reopening the other side remounts its own draft without parsing again. This replaces the old floating switcher that obscured the mobile editor header. The existing lazy editor recovery boundary and `demoMode` behavior remain intact.

The optional browser chunk has a finite load deadline, local Retry and render isolation. Closing or replacing a run invalidates old completions; cancellation clears session files/results while retaining only the bounded warm engine. Unsupported browser capabilities get Chrome/Edge or desktop recovery and never cause an upload. The legacy server request is also cancellable and has a whole-operation deadline during the compatibility period.

## Compatibility and retirement

The paragraphs below describe the historical one-release window. The
2026-10-28 retirement candidate removes its singular API router, parser-health
route and CLI spawn wiring. `off`/`admins` now offer desktop recovery without
landing intake; `/try` keeps its original rollout gates. The historical CLI
source, shared classifier and all generated engine assets remain unchanged.
No server parser is restored by switching the browser flag off. Verification
and release limits are recorded in the dated landing checkpoint.

The roadmap explicitly keeps the server parser for one release. During that window, `off` and `admins` retain the existing anonymous, rate-limited server demo and its honest upload copy. `all` uses the local browser path exclusively, including on failure. No new API flag or infrastructure is added.

After a full release has exercised the `all` path, a separate explicit retirement removes `/v1/public/preview-replay`, its health route, the API CLI wiring and obsolete tests. This implementation does not claim that a release has happened, execute one, or remove the rollback path prematurely.

## Verification

Required proof includes mocked-engine real-session lifecycle tests, both-perspective mapping, rejected/held/rendering chunk recovery, cancellation/stale completion, compatibility mode, API-free actual Chromium fixture parsing on the landing page, narrow/theme captures, types/lint and unchanged production bundle budgets. The engine source remains unchanged at `25b300818c31d41b`; any required prebuild is coordinated with the other worktrees.

The final local production build passes all existing budgets, including landing 191.1/215 kB gzip. The actual Next/Webpack worker test passes on desktop and mobile with both real build orders and no API traffic. The production-CSS fixture matrix passes 212 checks and 36 captures across four widths and both themes. These are signed-out public demo fixtures; the capture harness uses explicit local Next/auth/analytics boundaries and a Worker URL adapter, while the separate production Next test exercises Webpack's real Worker URL. Remote exact-head checks are required before merging.
