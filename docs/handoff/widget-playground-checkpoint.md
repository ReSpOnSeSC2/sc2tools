# Widget playground

Implements the exact Wave 4 `widget-playground` item in `.worktrees/wave4-stream-titles` on a new `codex/wave4-widget-playground` branch. The merged stream-title branch and unrelated temporary directories are preserved.

The shared grouped playground renders all 31 real widgets, seven scenarios, theme presets, an all-widget view, fit/actual-size modes and Replay sample. Settings cards open a local modal. Stream Studio loads it lazily and the guide replaces its illustrative image only after the interactive preview loads; server output still contains a useful WebP. The safe-test confirmation opens the public playground with only a widget ID.

Pure samples live in `apps/web/lib/overlaySamples.json`, including existing chat/studio and self-driven widget samples. API Test uses the same data. Preview context suppresses feed fetches, media grants, ticker polling, automatic reload checks and audio. The canvas is inert, so demo interactions cannot post actions.

Verification: 61 focused web assertions plus 25 existing widget assertions; 54 API assertions including Test route/safe-live behavior and a simulated image-layout load. API/web types and strict changed-web lint pass. The final manager head89d378 integrates cleanly, and the final required-engine production build passes every unchanged budget: landing214.4/215, Today227.4/240, Stream Studio118.4/130, all-in-one233.4/240 and standalone314.4/325 kB. Independent source review found no blocker. The full web suite and PR CI remain in progress.

The reproducible browser fixture passes352 assertions at320/390/768/1440 px in both themes using actual widgets, Settings, the public page and guide, with real production CSS and synthetic loopback data. Preview-only routes open zero network/audio transports. Every widget fits its stage; the poll-card regression checks readable use of the stage width. Fit measures painted content inside transparent source frames; the full source canvas no longer shrinks chat cards unnecessarily. Settings modal closure restores focus, lazy guide/public mounting works, and the page has no horizontal overflow. Eight screenshots are under `docs/handoff/screenshots/widget-playground-*.png`; the root reviewed the phone poll and desktop identity examples after correcting fit behavior.

Help `obs-overlay-setup#playground` and Crash Course `test-with-purpose` explain preview → Test in OBS. No new environment variable, secret, index, collection, migration or production setup is required. No integration, title or account was changed during verification.
