# More navigation Sheet consumer checkpoint

2026-10-26. Worktree `wave3-game-workspace`, branch `codex/wave5-more-sheet`,
from tested Auth `267ebf5801f39c17cb7a97cbade80c70be1f9b42` including chart main
`56e725ae`. Root preserved the initial consumer at `c7af2852`, integrated Public
at `37f1881c` and carried the shared clipboard test correction at `44181d75`.
Actual Auth main `8d7ec51d` is normally merged at `480a3cea`. That reconciliation
changes only the final Auth checkpoint: application source and all eight owned
path hashes remain identical to the tested working tree. No runtime repeat is
needed for that documentation-only merge. Earlier branches, original captures
and all prior caches remain preserved. This is one consumer slice of
`ui-primitives-and-dialogs`, not completion of its remaining migrations.

## Source contract

MoreSheet now uses existing `Sheet` with explicit bottom placement. Its rows,
destinations, actions, inline Light/Dark/System choices and close callbacks are
unchanged. AppChrome keeps ownership of pathname/desktop teardown, the More
trigger and report handoff. No MobileNav, NotificationBell, build shell,
branding, primitive, dependency, API or provider change is included. No existing
MoreSheet ratchet occurrence needs pruning; no baseline allowance was added.

New AppChrome consumers cover retained Sheet identity through theme changes,
real Modal report handoff with a concurrent scroll lock, pathname teardown and
an overlapping Appearance boundary including intermediate focus/Tab ownership.
The ordinary More flow offers inline themes, not a second Appearance trigger.
The overlap test invokes the existing account action synthetically. Actual
Chromium exposed the account fallback overriding Modal's return into More.
The approved AppChrome correction checks current modal ownership inside its
queued callback: an underlying modal keeps its restoration; ordinary closing
still returns to the stable account trigger. No trigger or primitive is added.

The existing appearance browser suite gains both-theme phone cases using a
new intercepted fixture. AppChrome, MoreSheet, Sheet, Modal, theme state and
navigation policy are real; auxiliary API/socket slots, Clerk and form contents
are explicit synthetic boundaries. The report boundary still uses real Modal.
The fixture reads actual `.next/static/css` and committed fonts, requires the
resolved palette, and denies host clipboard access. No server, external request
or account/provider write is needed. The same mounted Sheet is checked at 360px
and 700px, covering the old Modal's 640px centering seam below AppChrome's 768px
desktop teardown. Shared full-page AA checks have no new exceptions. Fresh
captures default to `.cache/more-sheet-evidence`, optionally
selected with `MORE_SHEET_SHOTS_DIR`; no committed image is overwritten.

## Verified local results

- Initial focused pack: 84 tests across nine AppChrome/Sheet/Modal/theme/focus
  suites. After the observed focus correction, all 60 affected tests across
  three suites pass, including AppChrome's 51 cases and queued desktop teardown.
- Full web types and six-file strict owned lint pass. New test-only errors
  (unsupported RTL options and an imprecise fixture Window alias) were corrected
  without weakening compiler settings or assertions. Supported Next typegen
  refreshed routes; the sole obsolete Community-page checker was verified
  against the moved source and preserved under the first proof directory.
- Help generation is deterministic at 89 articles. All 19 UI-rule tests and the
  scan pass: 1,671 source files, 656 inherited occurrences, no new/stale allowance.
- The final direct Next production build and post-build types pass, reusing the
  validated `1.6.12/fc21ebe5bf52a53c` assets without engine compilation. A Windows
  generated-directory EPERM was retained and the identical host retry passed.
  Every unchanged budget passes: Today 233.9/240, Community 188.4/190, Guides
  172.8/175, Builds 202.4/270, opponent 458.7/500, Dock 216.5/225 and Try
  213.8/240 kB gzip.
- Both complete native Chromium cases pass with one worker in 2.8 seconds.
  They prove real Tab, nested intermediate focus, ordinary account return,
  report handoff, same/changed-path closure, concurrent locks, both palettes,
  360/700px bottom bounds, desktop teardown, auth-return links and full AA.
  Unexpected requests, non-GET attempts and browser errors are asserted empty.
  Existing public appearance cases remain intact; this bounded run selected the
  two new synthetic phone cases. No application server was started.

The first focus failure and the later synthetic Clerk-menu cleanup failure are
preserved in `.cache/more-sheet-proof-44181d75` and its `-fix` sibling. The fixture
now closes its overlaid menu on action selection, matching Clerk; the native
focus and geometry assertions remain strict. Successful build/static logs are
in `-fix`, and final fixture types/lint, browser JSON/AA records and four captures
are in `.cache/more-sheet-proof-44181d75-final`. The exact eight-path manifest is
`.cache/more-sheet-owned-paths.txt`; no original screenshot was overwritten.

All runtime jobs are closed and the heavy slot is released. Root reviewed the
source and final Light 360px/Dark 700px captures; copies are preserved in
`screenshots/more-sheet-light-360.png` and `screenshots/more-sheet-dark-700.png`.
Exact-head remote checks and deployment verification remain pending. No
provider/account mutation, installer or SC2 operation was performed. MobileNav,
Bell, copy/confirmation consumers, branding and build dialog migrations remain
separate work.

Root normally integrated the independently tested rating-inspection/Macro
placement main `1c3d9877`, retaining both changelog sections. All More product,
consumer-test and fixture bytes are identical to tested `480de6c4`. The build
artifact contains 81 checks (18 explicit plus 63 default); the earlier PR's
80-count shorthand is corrected without changing any budget. Current combined
checks pass: 61 tests across the AppChrome, rating inspection and Macro placement
suites, plus full web TypeScript. A new exact-head remote run remains pending;
the local production and More browser evidence above predates this independent
main integration.
