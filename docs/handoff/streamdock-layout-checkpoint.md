# Stream Dock spacing and Chat order

Chat is first in the section registry, so the navigation, initial active item,
default layout and Reset layout agree. Deliberately pinned sections still keep
their saved order; collapsed state and drafts retain their existing behavior.

Series is the optional explicit best-of-1/3/5/7 scoreboard for cups and
showmatches. This fix changes presentation only: narrow containers place the
score below the players and give each player's correction buttons a full row.
Wider widget/desk containers retain the horizontal scoreboard. Long names
truncate with their full title available, and End/Refresh have an explicit gap.
The description and short Help link use separate lines.

Validation uses the existing six-file Series/layout behavioral group, plus a
local browser harness at 248/390/1280 in both themes. The harness renders real
Dock controls and the shared scoreboard with the repository CSS/fonts and a
synthetic Series API. It verifies add/remove, ended-state disabled controls,
80-character names, score/name separation and button/body bounds. Six cases
pass with twelve captures, no page errors and no external attempts. Root
visually inspected all twelve final captures. These are component-fixture
checks, not a live OBS or provider operation.

Run from apps/web with an already installed Chromium:

```
PW_CHROMIUM_EXECUTABLE=<installed chrome.exe>
SERIES_LAYOUT_OUTPUT=<new evidence folder>
node tests/manual/series-dock-layout.mjs
```

Full CI, production build and unchanged route-budget checks remain delivery
gates. No release, native launch, integration activation, dependency install,
infrastructure change or provider publication is needed.

## Standalone fixture compatibility repair

The first full web CI passed 9,216 tests (963 files, one existing test/suite
skip), and Vercel built successfully. Responsive CI exposed a separate bundler
integration issue: the new reusable scoreboard CSS-module import was reached
by Settings search/section fixtures that bundle JavaScript without an output
path. Their repeated errors exhausted the existing 25-minute job limit; there
is no final full-suite total for that cancelled run.

Move those same scoreboard rules into the existing globals.css components
layer, using static, uniquely scoped class names. The declarations, 22rem
breakpoint, grid areas and full-name title remain identical. The Dock-only
control module remains local. No fixture, assertion, timeout or budget is
relaxed. The repair's focused local checks and full CI remain pending when
this source checkpoint is written; retain the original cancelled-run evidence.
