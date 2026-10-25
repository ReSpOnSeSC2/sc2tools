# Twitch Predictions and game markers

Branch: `codex/wave4-twitch-predictions-markers` in `.worktrees/wave3-private-scouting`.

Local implementation, current-main and exact seven-minute-cutoff integration are preserved at `560474a0`. Local combined verification is complete; remote PR checks remain outstanding at this checkpoint.

## Behavior and capability

- Both user opt-ins default off. A separate server gate, `TWITCH_AUTOMATION_ENABLED`, also defaults off; configured provider credentials or saved user toggles cannot activate it. No environment was changed and no real account/provider/OBS operation was performed.
- Current desktop telemetry has no trusted ranked queue evidence. Automatic native Twitch Predictions therefore remain unavailable and report `ranked_status_unavailable`. Raw queue hints, MMR and Pulse/history cannot bypass that condition. Fresh accepted device two-human 1v1 starts can create saved, consented markers when the separate server gate is enabled later by its owner.
- Incremental OAuth preserves independently consented same-broadcaster scopes in both reconnect orders. Changed broadcaster identity inherits no old consent. Marker permission uses broadcast management; Predictions use their separate permission. Connecting changes neither opt-in.
- A unique owner/game TTL journal stores immutable exact provider/outcome IDs. Provider transport has bounded bytes/deadlines, generic safe errors and no blind create retry. Partial IDs cannot authorize resolution. Missing IDs withhold the refund CTA and explain manual Twitch inspection.
- Durable result/cancel intent survives CREATE races. Late cancellation cannot overwrite an already dispatched resolution. Known predictions request refunds for short games, timeout or confirmed Dock cancellation; only Twitch-confirmed cancellation is described as refunded.
- Pending dispatch has a 30-second grace and pending-only recovery CAS. Recovery never cancels a creating worker based on an old snapshot. Background work and local settlement mutations participate in the existing owner erasure lease; erasure purges the journal and snapshots never restore provider operations.
- Fresh replay settlement is independent of socket/overlay presence, and checks replay start proximity plus exact opponent/matchup identity. Recovery reads one indexed batch of at most 25 receipts, with global two-operation admission, finite pass time and no replay-corpus queries.

## Interfaces

- Strict Clerk-only PUT `/v1/me/preferences/twitchAutomation`; sanitized owner GET preserves other preference types.
- Private owner GET `/v1/me/twitch-automation` verifies/caches broadcaster status when enabled. Ordinary Dock reads never poll Twitch.
- Token GET/POST `/v1/multichat/:token/twitch-automation`; writes use exact token admission and no caller-selected winner. Reads revalidate token/owner after awaited status work. Replaced broadcasters cannot advertise controls for old receipts.
- Settings → Overlay → Chat & alerts has an optional lazy editor, local chunk Retry, explicit Save, window/template validation and separate permission buttons. Owner/loading/JWT/body/unmount/ABA fences cover reads and writes with a real 20-second deadline.
- Dock → Game has isolated lazy controls, default-cancel confirmation, stored verified-result resolution and explicit unknown/error/server-paused states. Busy submit focuses its progress status so Escape/scrim cannot strand focus outside the dialog.
- Learn anchor `/stream-studio/learn#twitch-predictions` and Help `/help/viewer-engagement#twitch-predictions` explain setup, limitations and recovery. Automation is not registered as a fake Browser Source widget.

## Verification

Focused API policy, OAuth, provider transport, real disposable Mongo journal/controller/routes and actual ingest wiring tests pass. API types and strict new-module lint pass. Controller/journal recovery race cases and held status→token rotation/revocation are covered.

Actual main `c7b9446f` was merged with explicit additive resolutions retaining owner native upload barriers, synced Ghost, Chat commands and Series. There is no native source difference against that main and no ProfileView change. Exact cutoff dependency `3dceab1c` was then merged cleanly. API and web types pass. Twelve integrated API suites pass **219 assertions**, including all seven Twitch suites plus Series routes, Chat preferences, Ghost, device live ingest and Moments. Main's reviewed effect-loaded Dock helper resolves the previously diagnosed initial-suspension loop: all nine affected Dock/lazy/Twitch suites pass **86 assertions**, including the five previously uncompleted consumers. The full web suite now passes **7,625 assertions, 844 files, one existing skip**, without heap changes or worker errors. The post-cutoff definitions/catalog consumers pass another **26 assertions across 3 files**. Strict new-module API/web lint passes.

Focused web, old Learn consumers and Help/article/link/index checks: **72 assertions across 8 files passed** before the final busy-focus/browser follow-up; the named-popup replacement regression passes in the expanded 11-case Settings consumer. Full API: **5840 passed, 6 skipped, 412 suites, 1 snapshot**. The unsharded local web run passed 823 files/7476 assertions but five real Dock consumer workers exhausted the default heap; a bounded diagnostic confirms the second initial Suspense island exposes the already-corrected shared loader issue. Actual main's reviewed effect-loaded DockLazyPanel will be integrated before rerunning those consumers. This run is not claimed as a full-web pass.

After cutoff integration, required engine prebuild and smoke passed for `25b300818c31d41b`: 223 files, 79 pyc, 1.19 MiB; smoke payload 142939 bytes. The final isolated Next production build passed with a synthetic public Clerk fixture key. All unchanged budgets passed, including landing **214.9/215**, Today **239/240**, Dock **215.3/225**, opponent **471.7/500**, widget **322.5/325**, Settings **179.9/260** kB gzip.

Final integrated production-CSS Chromium matrix: **396 checks and 46 captures** across 300/320/390/768/1440, light/dark, reduced motion and coarse pointer on narrow contexts. Real Settings/hook, Dock/dialog and public Learn components use final production CSS/fonts (`085eec6ea1a84fdf`, `54f1d62a562fcc18`, `9e93c7f0ce562f59`, `c8183fd076b4bf97`). Explicit local boundaries are Clerk/Next/Twitch API and an inert named-popup recorder. **Zero external or unexpected API requests.** Tests cover default-off/no silent write, invalid inputs, exact Save/purpose bodies for both consent flows, named-popup replacement, held JWT owner switch, keyboard/44px targets, Cancel focus/no write, confirmed refund, immediate busy focus through Escape/scrim, unknown-ID withholding and no overflow.

Screenshots use `docs/handoff/screenshots/twitch-automation-*.png`. Representative 300/320/768/1440 captures in both themes were opened and inspected, including full-page mobile forms, dialogs, busy/unknown state and Learn; no visual blocker remains.

Independent API and UI review is clear after the final read-token fence and pending-recovery CAS corrections. Owner lifecycle/consent, provider IDs, unknown-state handling, request deadlines, account transitions and confirmation focus were reviewed. No integration, account or server gate was activated.

Reproduction from `apps/api`: `node node_modules/jest/bin/jest.js __tests__/twitchAutomation*.test.js --runInBand --cacheDirectory .cache/jest-twitch` (use explicit paths on Windows if the shell does not expand the glob). From `apps/web`: focused Vitest consumer/parser suites, `node node_modules/next/dist/bin/next build`, `node scripts/check-perf-budget.mjs`, then `node tests/manual/twitch-automation.cjs` with the local Playwright browser directory configured. Never run an old-source engine prebuild after the newer cutoff bundle is published.
