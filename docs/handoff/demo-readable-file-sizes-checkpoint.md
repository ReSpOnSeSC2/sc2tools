# Home-page demo readable file sizes: October 28 UTC

This narrow follow-up starts from clean main
`ccb5987e145968059097ecf440204c3972279ded` on
`codex/demo-readable-file-sizes` in the isolated Help checkout. The program and
`landing-try-polish-1` ledger remain parent-owned; no roadmap ledger is edited.
The frozen stage 2 API checkout is untouched.

Actual production acceptance of PR 802 at merged revision
`263a0805abb4084ea70460a02a3a217d5f16a76e` observed an owned
synthetic 1,024-byte invalid replay displayed as **0.00 MB** in the private error
dialog. The original receipt, fixture and screenshot remain in
`C:\SC2TOOLS\.cache\help-recovery-completion-verification-20261028\production-263`.
That receipt is the bug observation, not acceptance of this later candidate.

An import-free shared formatter now supplies all three existing label sites:
legacy `ReplayDemo` busy status, optional `ReplayDemoBrowserIsland` loading/error
and private `ReplayDemoBrowserSession` loading/error. Values below 1,024 bytes
use B; below one MiB use two-decimal KB; one MiB and above retain the exact
two-decimal MB format. Thus 1 byte is **1 B**, 1,024 bytes is **1.00 KB**, and
the existing 2 MiB fixture remains **2.00 MB**. File.size already supplies a
nonnegative integer; the formatter imports nothing and loads no dependency,
payload or engine code. Filename handling is unchanged.

Request ownership, cancellation, focus, picker recovery, Retry, optional-chunk
deadlines, local session privacy and the disabled-mode compatibility path are
unchanged. There is no new endpoint/request, flag, provider, infrastructure,
native/agent or engine-asset change. The existing compatibility request is
still exercised only in its previous flag modes; a private failure never falls
through to it.

The three actual component suites pass 23 cases. New cases render held
legacy requests and held/rejected optional imports at B/KB/MB sizes, and use
the real private-session controller with a 1 KiB pending scan then Not a replay
error. They retain error focus, recovery buttons and no private API calls.
Unsupported-browser recovery now asserts the same 1 KiB label. Original
2.00 MB private loading and request/stale-response assertions remain.
The incorrect old 1-byte/0.00 MB expectation is corrected to 1 B. No arithmetic
mirror test replaces component behavior, and no assertion or failing test is
removed to manufacture a pass.

Help regression passes another 25 cases: **48 cases across four suites**.
Whole-web types pass, and all eight owned TypeScript/source/test/Help paths
pass strict lint with zero warnings. `git diff --check` passes. Independent
review remains separate. No build, browser, CI, commit, push, merge or
production acceptance is claimed. Parent release checks must retain all 83
route budgets and engine assets; no cap change or regeneration is included.

Evidence packet:
`C:\SC2TOOLS\.cache\demo-readable-file-sizes-verification-20261028`.
Exact pre-edit files and SHA256 pins are preserved in `preimages/` and
`preimages.json`. The first focused run passes in `web-demo-unit-01.log`, with
at most two unit workers. No long-lived process/listener is started by this
component/type/lint workflow.
