# Macro modal timeline and army fit

Owner-priority correction, source candidate based on main
`b8ef1b945effef54d9f7bad13e5ee27f1525a3db`. This supersedes the earlier
request to leave Macro unchanged. The owner confirmed the timeline and
both armies, rather than the replay map.

The panel keeps a compact sticky header with full-width match metadata,
an accessible full-game link and a 44px Close button. Only its timeline
visualization/readout and the two composition cards enter a locally
transformed overview. Metric, bank, supply and Fit/zoom controls remain
unscaled. Fit is enabled only on narrow screens or with a coarse primary
pointer, including landscape phones. Normal desktop and other Macro
callers keep their existing layout; casualties,
the replay player and the remaining panel body stay outside the stage.

Fit measures logical content and reserves its scaled physical width and
height, clipping the unscaled overflow footprint. The overview uses up
to 576 logical pixels on a phone, with two explicit roster columns and
44px logical chip targets at every breakpoint. Scale never goes below
24/44. Very dense content, large text or a short viewport can scroll
locally instead of clipping rows or shrinking targets further. Fit,
75%, 100%, 125% and 150% zoom remain panel-local, reset on close/game changes,
and adapt to resize and late content. No viewport metadata, browser
zoom policy, global font size, persisted zoom or gesture interception
is added. The existing chart uses its physical plot bounding box once
for pointer-to-time mapping; chart and roster still share the same
series, selection and build-order request.

The older `macro-header-scroll` worktree is dirty and intentionally
preserved. Its unmerged changes were not adopted. Root's header draft
preimage and the design are retained under
`.cache/macro-mobile-fit-20261028/`.

Local verification passed on the initial base: 277 cases across 19 files
before the no-observer fallback, followed by 59 current cases across 8
files covering that delta and the real panel/section/composition
consumers. These are separate runs. Whole-web types, strict lint on all
13 owned TypeScript files, the four new product modules' complexity/
function/file limits, and the unchanged official UI-lint baseline pass.
All 3,531 web input hashes stayed unchanged during each current command.
The original tests remain unchanged. Two failed lint attempts are
retained; supply-label association was made explicit, and the extra
scroll-region tab stop was removed. Real roster buttons provide
keyboard entry without changing the region's semantics or lint rules.
Observed owned processes and listeners are closed, with no kills.

Exact receipts are under `.cache/macro-mobile-fit-20261028/`. Current
source is independently reviewed; these local checks are not responsive
or accessibility evidence. Integrating passed main, a production build,
all 83 unchanged budgets/source/asset guards, and real production-CSS
responsive/target/focus/AA checks remain required before delivery. No
release, production acceptance or roadmap closure is claimed.
