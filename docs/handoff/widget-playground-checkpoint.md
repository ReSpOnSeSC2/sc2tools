# Widget playground

Implements the exact Wave 4 `widget-playground` item in `.worktrees/wave4-stream-titles` on a new `codex/wave4-widget-playground` branch. The merged stream-title branch and unrelated temporary directories are preserved.

The shared grouped playground renders all 31 real widgets, seven scenarios, theme presets, an all-widget view, fit/actual-size modes and Replay sample. Settings cards open a local modal. Stream Studio loads it lazily and the guide replaces its illustrative image only after the interactive preview loads; server output still contains a useful WebP. The safe-test confirmation opens the public playground with only a widget ID.

Pure samples live in `apps/web/lib/overlaySamples.json`, including existing chat/studio and self-driven widget samples. API Test uses the same data. Preview context suppresses feed fetches, media grants, ticker polling, automatic reload checks and audio. The canvas is inert, so demo interactions cannot post actions.

Verification before integration: 61 focused web assertions plus 25 existing widget assertions; 54 API assertions including Test route/safe-live behavior and a simulated image-layout load. API/web types and strict changed-web lint pass. Required-engine production build and all unchanged budgets pass: landing214.4/215, Today227.4/240, Stream Studio118.4/130, all-in-one233.4/240 and standalone314.4/325 kB. Real-browser proof, final integration and CI remain to be recorded before merging.

Help `obs-overlay-setup#playground` and Crash Course `test-with-purpose` explain preview → Test in OBS. No new environment variable, secret, index, collection, migration or production setup is required. No integration, title or account was changed during verification.
