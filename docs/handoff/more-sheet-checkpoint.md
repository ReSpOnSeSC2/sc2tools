# More navigation Sheet consumer checkpoint

2026-10-26. Worktree `wave3-game-workspace`, branch `codex/wave5-more-sheet`,
from tested Auth `267ebf5801f39c17cb7a97cbade80c70be1f9b42` including chart main
`56e725ae`. Earlier chart/UI branches, original captures and all prior caches
remain preserved. This is one consumer slice of `ui-primitives-and-dialogs`,
not completion of its remaining migrations.

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
The overlap test invokes the existing account action synthetically; production
account-focus policy is unchanged. It must be observed before claiming proof.

The existing appearance browser suite gains both-theme phone cases using a
new intercepted fixture. AppChrome, MoreSheet, Sheet, Modal, theme state and
navigation policy are real; auxiliary API/socket slots, Clerk and form contents
are explicit synthetic boundaries. The report boundary still uses real Modal.
The fixture reads actual `.next/static/css` and committed fonts, requires the
resolved palette, and denies host clipboard access. No server, external request
or account/provider write is needed. The same mounted Sheet is checked at 360px
and 700px, covering the old Modal's 640px centering seam below AppChrome's 768px
desktop teardown. Shared full-page AA checks have no new
exceptions. Fresh captures default to `.cache/more-sheet-evidence`, optionally
selected with `MORE_SHEET_SHOTS_DIR`; no committed image is overwritten.

## Verification pending

Source only. No scripts, generators, unit tests, typecheck, lint, build or browser
has run for this pack. Try owns the local runtime slot. The exact seven-path
manifest is `.cache/more-sheet-owned-paths.txt`.

At the coordinated slot: run affected AppChrome/Sheet/theme consumers (at most
two workers), complete web types, strict owned lint, Help generation and UI
ratchet. Root reviews the source before one final production build and unchanged
budgets. Run the two new phone/both-theme appearance cases with one worker and
the installed Chromium via `PW_CHROMIUM_EXECUTABLE`; retain the existing public
appearance cases. Check trigger return, real Tab, nested Escape and intermediate
focus, report transition, same-path/changed-path closure, lock ownership,
desktop teardown, viewport bounds and actual AA. Report a real overlap failure
before changing production focus policy or claiming a passing result.
