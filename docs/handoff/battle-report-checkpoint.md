# Battle report implementation checkpoint

Implements final-plan `battle-report` on new `codex/wave3-battle-report`, reusing the clean merged export worktree at `.worktrees/wave3-build-exports`. The original export branch/head remains preserved. It starts from tested game-story math `50116a49`; completed Story UI/main changes must be integrated before the final PR. This checkpoint records work in progress, not shipped status.

## Root's engine contract and provenance

Root owns `apps/web/lib/battleReport`: typed factual observations with source/game times, bounded snapshot-moment selection, deterministic 1–4 paragraph planning, three tones with 144 typed fact-slot templates, generated headlines and plain/Markdown copy. Only existing owner game/build/macro/playback data is read. Missing GG/chat/end conditions are omitted. Planned check-ins and replay classifications stay distinct; measured swings never claim causation. Estimated/unmeasured fights keep their missing-data distinctions. Reports must receive complete playback payloads only: feeding the viewed segment into factual extraction would make the narrative change when seeking.

The fixture corpus is explicitly synthetic and covers 12 recognizable game shapes across all nine matchups: all-in, cheese loss, macro win, comeback, town-hall exchange/base trade, short ending, mirrors, worker harass, missing detail and sparse legacy. Every tone has golden text snapshots (36 total). Provenance/numeric-slot tests, template lint, no-repeat checks and a 200-seed variety test enforce the factual template contract. No private replay/account/provider was used.

Engine validation: 51 tests/36 snapshots, full web types and strict source lint. Independent review's fact-level findings have explicit regressions: time bounds precede derivation and also filter injected stories, snapshot moments and nearby battle-marker locations; owner check-in labels without classifier evidence are never called replay classifications; penalty-only leaks do not claim a resource price; estimated frames keep estimated captions; town-hall starts do not assume an expansion location; turning intros make no unsupported superlative claim. Unused upstream recap text is not carried into report facts.

## Data and UI

- Root's reviewed pure engine is committed through `04162857`: typed, bounded facts; one to four paragraphs; three seeded tones; 36 golden text snapshots; no model, endpoint or clock read. Confirmed plans/corrections remain distinct from classifiers, estimated observations are labeled, and unsupported end conditions stay absent.
- The game page lazy-loads the report near the top and shares one existing `useMapReplay` controller with the replay section. It uses existing summary, macro, build-order and check-in data. Replay build-order races take precedence over fallback summary races. Another game's intent is ignored.
- Only complete, nonsegmented playback can supply narrative weapon facts or map stills. Window arrivals and seeks cannot rewrite the account. Snapshots are sorted by game time; a recording that does not cover a moment uses the chart fallback.
- Embedded known timestamps seek their exact recorded times through the shared game clock; metadata such as player/corrected-build names is never parsed as a clock. Facts without an embedded clock get a watch-time link. Modified-click links retain an encoded owner-game URL.
- Snapshots reuse the stage's existing renderer with an optional dot mode; default playback remains unchanged. Units use race-colored dots, structures squares; own marks are solid and opponent marks outlined so mirrors remain distinguishable. Text identifies sides/races. The still renderer redraws only for initial/settled assets, sizing and explicit theme changes, and clears all timers/observers when unmounted.
- Missing map frames use a cropped recorded army-value chart, with gaps for explicit missing values or intervals over 30 seconds. Missing nearby samples show an unavailable message. Report controls never start a recording or publish anything.
- Copy text/Markdown supports a selected-text fallback. Copy stays disabled while recorded details are initially loading. Help article `battle-reports` describes the controls, data limits, frames and copy links.

## Verification so far

- 93 tests pass across the reviewed pure engine, report/snapshot/page-input consumers and game-page/recovery suites. This includes 51 core cases/36 golden snapshots and the real mounted-player timestamp wiring regression.
- Full web types and strict changed UI/renderer/help lint pass. Source engine files remain owned by root; UI changes are staged independently.
- Still pending: integration of finished Story/main, regenerated Help index, final affected tests/production build/budgets, real browser checks/screenshots, independent review, PR and green-CI merge.
