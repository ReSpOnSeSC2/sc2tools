# Twitch Predictions and game markers

Branch: `codex/wave4-twitch-predictions-markers` in `.worktrees/wave3-private-scouting`.

Local implementation and focused verification are complete. Fresh-main/cutoff integration, final combined gates and remote PR checks remain outstanding at this checkpoint.

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

Focused web, old Learn consumers and Help/article/link/index checks: **72 assertions across 8 files passed** before the final busy-focus/browser follow-up. Full web/API runs are recorded separately when complete.

Required engine prebuild passed for the then-current `f96c086eb83fdc40` source: 223 files, 79 pyc, 1.19 MiB; smoke payload 142939 bytes. This old prebuild is frozen; later seven-minute-cutoff source must be integrated before any new required prebuild. The isolated Next production build passed with a synthetic public Clerk fixture key. All unchanged budgets passed, including landing **214.8/215**, Today **238.9/240**, Dock **214.7/225**, opponent **476.2/500**, widget **319.2/325**, Settings **179.8/260** kB gzip.

Actual Chromium matrix: **376 checks and 46 captures** across 300/320/390/768/1440, light/dark, reduced motion and coarse pointer on narrow contexts. Real Settings/hook, Dock/dialog and public Learn components use final production CSS/fonts. Explicit local boundaries are Clerk/Next/Twitch API and an inert popup recorder. **Zero external or unexpected API requests.** Tests cover default-off/no silent write, invalid inputs, exact Save/purpose bodies, held JWT owner switch, keyboard/44px targets, Cancel focus/no write, confirmed refund, immediate busy focus through Escape/scrim, unknown-ID withholding and no overflow.

Screenshots use `docs/handoff/screenshots/twitch-automation-*.png`. Representative 300/320/768/1440 captures in both themes were opened and inspected, including full-page mobile forms, dialogs, busy/unknown state and Learn; no visual blocker remains.

Reproduction from `apps/api`: `node node_modules/jest/bin/jest.js __tests__/twitchAutomation*.test.js --runInBand --cacheDirectory .cache/jest-twitch` (use explicit paths on Windows if the shell does not expand the glob). From `apps/web`: focused Vitest consumer/parser suites, `node node_modules/next/dist/bin/next build`, `node scripts/check-perf-budget.mjs`, then `node tests/manual/twitch-automation.cjs` with the local Playwright browser directory configured. Never run an old-source engine prebuild after the newer cutoff bundle is published.
