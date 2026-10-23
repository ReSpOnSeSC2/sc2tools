# Wave 2 streaming polish checkpoint

Branch codex/wave2-streamer-polish; isolated worktree wave2-streamer-polish.
Base main 17ab0ff2. Scope: streamer-polish-2 and streamer-polish-3, all specs,
with no augments listed in final-plan.json. Runtime/installer drafts are frozen
and parent-owned for integration; no agent version, tag, signing or setup action.

Implemented mounted build voting and matchup filters, error recovery and winner
links; four scene modes through API/client/renderers, shared quick times and
per-token message presets; current-snapshot Block/Undo/Unblock with cap and
Settings-managed entries; both poll screens exclude blocked authors. Closed Dock
polls freeze like the OBS widget and tied build votes identify a tie.

The public studio now uses shipped agent copy/constants and guide links, retains
signed-out SSR CTAs while auth loads and shows signed-in setup/course shortcuts.
Learning adds a desktop-open gallery, course reset/Undo, scroll spy and shared
button variants/offsets. Stream Dock help/guide content and changelog are updated.

Verification: full web suite passed 6,274 tests with one intentional skip across
651 files (220.19 seconds). Subsequent focused checks cover the final scene copy,
filter styling and shared guide offset. Actual HTTP/Mongo multichat suite passed
72 tests; API typecheck/lint and strict changed-web lint pass (the API files have
pre-existing function-length warnings).

The first build exposed a Clerk import increasing /stream-studio to 171.5 kB.
The authenticated island now loads on demand behind useful signed-out HTML;
production build and all unchanged budgets pass, including /stream-studio
115.6/130 kB, Dock 212.1/225, /app 234.5/240 and opponents 175.8/180. A final
build is rerunning after the selected-guide scroll offset was unified.

Actual Chromium verification uses the production components/CSS/font variables,
fixture hooks/API responses and no live account. Seven flow groups pass at
390/1440px: keyboard build selection/filter/vote/winner, scene transitions and
ending start-time guard, block Undo/read-only management, desktop-open gallery,
full course-progress Undo, reduced-motion scroll spy, section/selected-guide
focus clearance, authenticated CTA choices, light/dark layout and no horizontal
overflow. No page errors. The production static HTML contains signed-out CTAs.
Five screenshots in docs/handoff/screenshots/streamer-*.png were inspected.
Browser verification found and fixed a subpixel scroll-spy boundary issue.

Deploy the API before this web change so scene writes accept the two new modes.
Refresh existing OBS scene Browser Sources once after deployment. No new env vars
or infrastructure. Source/browser verification does not claim a live OBS session.

API agent owns safe-test-fire and its Settings/overlay handlers. This branch
changes only the API scene allow-list and route tests; SettingsMultiChat only
gains the Dock URL-row anchor. No new infrastructure, AI feature or AI API call.
