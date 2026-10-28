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

## Earlier local verification

Local verification passed on the initial base: 277 cases across 19 files
before the no-observer fallback, followed by 59 cases across 8
files covering that delta and the real panel/section/composition
consumers. These are separate runs. Whole-web types, strict lint on all
13 owned TypeScript files, the four new product modules' complexity/
function/file limits, and the unchanged official UI-lint baseline pass.
All 3,531 web input hashes stayed unchanged during each of those commands.
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

## Nested-dialog semantics repair — fresh browser verification pending

After integrating passed main at `39ea4843`, the first four-case browser run
reached unit details and failed the full default Axe duplicate-banner/unique-
landmark rules. Eight initial/selected scans had passed; four nested scans
failed. Later lifecycle steps were unverified. The failed report, traces,
6,963-source/asset guards and owned cleanup remain preserved in cache.

Only the header/footer containers in MacroBreakdownPanel and shared Modal now
have `role="presentation"`. Their tags, refs, layout, headings, buttons and
handlers remain unchanged; application page landmarks are untouched.
[ARIA in HTML](https://www.w3.org/TR/html-aria/) permits this role on these
containers. The [APG presentation guidance](https://www.w3.org/WAI/ARIA/apg/practices/hiding-semantics/)
keeps independent descendant headings and controls exposed.

The broad semantic regression run passed 257 cases and failed one new oracle
across 21 files: the installed unit role mapper treats section-scoped headers
as document banners. Only that new helper was corrected to the normative
native-header/footer scoping rule. Explicit landmark roles and unscoped
dialog headers remain detectable, with negative controls proving this.
Original Macro and Modal tests remain unchanged. The fresh targeted run
passes 27 cases across seven files, whole-web types, strict lint on all 15
owned TypeScript files and the unchanged UI-lint baseline. All 3,534 inputs
remain exact during each current command. Owned processes/listeners are
closed; no process was killed.

No browser rule, exclusion, expectation or budget was relaxed. Fresh build,
all 83 unchanged caps/source/asset guards and the same real responsive/focus/
target/full-Axe browser verification remain required before delivery.

## Page position on close — fresh build/browser verification pending

The second browser run passed both desktop cases and all 16 full-default Axe
scans. Both phone cases reached the final close assertion but retained a page
scroll change caused during orientation; repeat-open steps were not reached.
Paired controls kept the page at the original position with only opener focus
or body overflow locking, while the real Macro dialog reproduced the drift
without inspecting or zooming. Reports, traces and unchanged source/asset
guards are preserved; the original exact close-position assertion is retained.

Macro now captures the page coordinates and URL once per open. After unlocking,
ordinary same-page close/unmount restores the connected opener with
`preventScroll` and restores both coordinates, including when the opener was
removed. A Full game navigation-intent latch and changed-URL guard suppress
both restorations during navigation. Passive data, inspection and game changes
do not restore or recapture page position; shared body locking is unchanged.

Local checks passed 31 cases across six files, followed by a focused ten-case
rerun after making the isolated Next Link test adapter's href/children explicit.
The other 21 consumer cases and product bytes are unchanged; these are separate
runs. Current whole-web types and strict lint on 16 owned TypeScript files pass.
All 3,535 web inputs remain exact within each command. The first three test-seam
lint warnings and raw PID observations are retained. Exact-identity settlement
finds no remaining observed owned processes/listeners or unknown scoped rows;
a proven unrelated Chrome PID reuse is excluded, with no kills. This is local
synthetic-router evidence, not actual Next navigation or production acceptance.
Fresh build, unchanged budgets/assets and the original responsive browser
matrix remain required.
