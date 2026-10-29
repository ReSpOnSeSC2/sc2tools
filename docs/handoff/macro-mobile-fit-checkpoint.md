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

## Nested-dialog semantics repair — retained earlier verification

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

## Page position on close — retained earlier verification

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

## Local gate at cd25 — retained before delivery

This section supersedes earlier pending local build/browser wording.
The preserved clean source is `cd25ed68f222c48cc80c0a8bcb6d174fe1064cfc`,
based on passed main `e84cd77397033a5c46c5fcb2bfd936b42f499950`.
Direct production build `EE76oB0LZMFMkqAEyZDxe` passed all 83 unchanged
route caps and the 6,965-source / 40 canonical / 7 active / 4 strict sample
pre/post guards, using one static worker and a 4 GiB heap.

The original four-case browser matrix now passes at 320 light, 390 dark and
1280 in both themes. All 16 full default Axe scans have zero violations;
233 physical target observations pass. Both original exact phone close-position
assertions and repeat-open steps are reached and pass. Touch scrubbing, keyboard
pan/auto-reveal, local Fit/zoom, late data, game reset, desktop baseline and
nested modal focus/Escape pass without changing the original spec assertions.
The run binds 311 actual product inputs, fresh production CSS and three fonts.
Postbrowser source/asset guards remain exact; cleanup records 21 observed
identities and zero owned/unknown processes/listeners, with no kills.

The compact summary and two byte-exact, independently viewed LOCAL PNGs are in
[validation/macro-mobile-fit](validation/macro-mobile-fit/README.md).
All raw reports, traces, earlier failures and original process observations
remain in cache by hash. The fixture uses synthetic Clerk, GET game data and
Next primitives; actual Next router/transport, account behavior and mobile
hardware are not proved by it. No product assertions, Axe rules, budgets or
asset allowances were weakened. Later documentation/capture adoption is a
metadata-only boundary after the 6,965-source guards.

Exact final-head CI, deployed-revision verification and actual signed-in Macro
acceptance remain required. This owner correction changes no roadmap status:
197 original items remain reconciled as 124 completed, 53 partial and 20 open,
with 73 unfinished. No cache activation, provider or cost change is claimed.

## Community CI selector compatibility

Initial PR812 head `27f6ef96` passed web checks; responsive CI recorded 588 passes,
three failures and 92 existing skips. All three failures used a document-footer
landmark to locate the Community dialog Close button. The corrected test keeps
that exact button scoped to the native dialog footer and adds semantic guards.
All original assertions remain intact; product code and Modal roles are unchanged.

All 12 existing cases across the three original projects pass locally with no
skips or retries. Strict spec lint, 6,970 current-source guards, unchanged EE76
runtime and 40/7/4 asset guards pass; owned servers/listeners are closed. The
[compact summary](validation/macro-mobile-fit/current-cd25ed68.json) pins the
retained Codex failure and current receipt. These documentation edits follow
that frozen run. Exact-head CI and live acceptance were pending at that
pre-release boundary; the later passed release and acceptance are recorded below.

## Delivered Macro release at dfe4

Macro was merged as `dfe4d6234e9242bad9ff5d4a52ad2e36cbb7bc78` after
the exact release-head checks passed. Vercel was verified Ready/Production
at that merged revision. Actual signed-in acceptance on the primary site
showed the timeline and both army columns with a 44px Close control.
Escape and Close each restored the exact state captured for that opening,
including focus and global styles. The real Full game link loaded the normal
game page with no Macro portal or Fit group remaining.

The actual production viewport was desktop 1920×889. Phone/touch behavior
remains proved by the retained LOCAL four-case matrix and 16 full default Axe
scans with zero violations; no actual mobile production session is claimed.
Two earlier attempt/oracle failures remain private and are not relabeled as
successful checks. The sanitized [production receipt](validation/macro-mobile-fit/production-dfe4.json)
contains no private URLs, identifiers, names, gameplay counts or photos.

These three delivery documents are adopted after Auth98b9's local checks.
Its b071 receipt still describes 77 then-current pins, before the Macro
checkpoint/README updates and the new production receipt. All 1,024 API
inputs, dependencies and web application bytes are unaffected by this
documentation-only boundary; no old log or guard is rewritten as post-docs.
This records Macro delivery, not deployment of pending Auth changes.
The original 197-item ledger and 73 unfinished items remain unchanged.
