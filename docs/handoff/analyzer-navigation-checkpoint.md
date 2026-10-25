# Analyzer navigation — analyzer-home-polish-5

Owned branch `codex/wave3-analyzer-navigation`, reused preserved Health worktree
`.worktrees/wave3-build-exports`. Actual main through GameDesk732's34b14d7f
(including the owner's9bb3f5ca Randomizer/native fix) is reconciled, with
reviewed Scouting729 source through a5abe9da. PR731 is the combined analyzer
integration;729 remains preserved until731 passes all final gates and merges.

Implemented: shared global/section URL transport with drafts and committed
values, controlled Strategy/Builds/Arcade/Maps route views, Strategy push/Back
ownership and direct-link replace, Opponents canonical sort/query controls,
compact URL-based Replay controls/cursors/date/empty reset/row return, and Daily
Pulse opt-in/carousel/context links. Legacy replay keys and opponent sort+dir
remain readable; explicit edits write canonical state. Copy links retain known
section state while omitting credentials and unrelated parameters.

Replay source handed back by stream_titles with30 scoped tests/types/lint clear.
DailyPulse source handed back by build_studio with51 scoped tests/types/lint clear.
Root core11, Strategy model3, wrapper6, Copy6 and existing Provider URL/account/
map/persistence assertions pass in their recorded runs. Independent review found
and fixed Next history-metadata replacement/late-ack ownership races; the fixture
now drops custom state as the real router does. Combined169 assertions across22
focused suites pass (168 in the broad run plus the final first-ack regression).
Help index is regenerated. Pre-owner full web run:824 suites passed, one expected skipped;
7,495 tests passed, one expected skipped. Both later carousel fixes also pass
15 focused assertions. Full web types and strict changed-source lint pass.

The reproducible manual fixture passes 232 grouped browser checks at
320/390/768/1440 in both themes, with 32 checked-in captures and no page errors
or unexpected API routes. It uses real route wrappers, SWR consumers, global
filter URL synchronization, native Back/Forward and a reactive Next boundary
that drops custom history state. Game/dossier detail bodies, unrelated
chart/Arcade bodies and the four-card Pulse corpus are explicit fixture
boundaries. External traffic is blocked. Root inspected the narrow dark Pulse
and light Replay controls; independent review also inspected sheets and the
desktop opponent table. Browser evidence found and fixed the carousel padding
snap boundary and cards wider than the narrow container; strict measured
width, button-end-state and reduced-motion assertions now pass.

The owner9bb integration adds53 affected web and31 native test passes, with a
fresh232-check browser matrix using the integrated production CSS. The manual
runner now resolves its web directory itself and works from the repo root.
The actual GameDesk squash adds38 passing integration consumers, clean API
types and another successful production build. Its exact-channel and bounded
ended-game fields are retained beside scouting's optional map semantics.

Required engine build/smoke passes atf96c086eb83fdc40. Final production rerun
and every unchanged budget pass: Today232.2/240, Dock215.2/225,
landing214.6/215, Opponents132.4/180, Dossier476/500,
Overlay236.7/240 and Widget317.8/325kB. All applicable API/native/web final-head
CI, Vercel and a fresh main merge tree remain merge gates. No failed-check
head is merged;729 is superseded only after successful combined integration.

No budget, infrastructure, production, provider, release or version action.
Continue all remaining roadmap waves and the final owner setup guide.

## Current main, requested timing and retained live layout

Integrated released Ghost/Series/Chat main `c7b9446f` and the reviewed PR740
seven-minute Void Ray/Phoenix source, including both generated API catalogs.
The required browser engine is `25b300818c31d41b`; build and smoke pass.

The user's latest clarification supersedes the proposed top reorder: retain
the exact live order **Brief → Tendencies → Timings → History → Ladder →
Identity**, with History/Ladder near the bottom. PR739 was never merged and
is closed. Its temporary integration is reverted by `cf7eac11`; the forecast,
history cursor/filter behavior and replay card above notes remain intact.
Future work must preserve this order unless the user explicitly changes it.

The final source passes 21 profile consumers, both API/web types and 41
integrated Ghost/scouting/rivals/Chat preference assertions. The owner native
upload barrier is identical to current main. Actual browser verification passes
232 navigation checks plus 122 real dossier checks, including exact rendered
section order and Brief/History navigation at all four widths in both themes.
The two kept-live-layout captures were inspected. No dossier writes or external
traffic occurred. New matrix captures use `NAV_SHOTS_DIR` in local cache;
the eleven previously unstaged navigation screenshots remain untouched.

The final kept-layout production build and every unchanged budget pass:
landing 214.7/215, Today 232.4/240, Opponents 132.6/180, Dossier 471.5/500,
Dock 215.9/225, Overlay 239/240 and Widget 323.2/325 kB. Final-head remote
GitHub and Vercel checks remain required before merge.
