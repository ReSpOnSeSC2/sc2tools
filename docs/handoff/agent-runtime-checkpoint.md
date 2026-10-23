# Wave 2 desktop runtime checkpoint

Scope: agent-window-tray-folders, agent-match-aware, agent-gui-polish-3.
Branch: codex/wave2-agent-runtime, based on pairing recovery / calm sync PR #661.

Implemented native relaunch activation; shared timed pause and tray routing;
redirected folder discovery, metadata rows and instant Undo; one structured status
model/card/sidebar/tray dot; match-aware history/archive/capture gating; lower
priority performance profiles; safe-time installer scheduling and persistent
update notes/actions. Help leaves, README, and Unreleased notes accompany them.

Integrated main 076a61f6 and corrected #661 c2acfbb5 at f5cd2aa9.
Exact integrated source verification: 2,075 Windows agent tests passed,
1 skipped, 78 subtests (153.54 seconds); all 100 help/search/render tests passed;
web typecheck, touched-file lint and help index generation passed. The production
build used the exact CI flags and all unchanged route budgets passed, including
/app 236/240 kB, opponents 175.6/180, builds 188.1/270 and help 150.1/185.

Native screenshots in docs/screenshots/agent-runtime-*.png show Dashboard, notes,
Settings and an independent service notice. These use demo versions/notices,
not a published installer. Activation is checked across two actual processes;
real parse-worker priority, queue/archive/capture holds, durable timed resume,
folder Undo, and Qt wheel hit testing are covered.

Service notice parsing from the announcements work was cherry-picked separately
as 9f7cc88c. Its native client uses a separate plain-text card, safe relative links,
tray menu/one toast per hash, and expiry without another network check. The full
suite includes this client. API/web announcements can deploy independently;
notices remain optional in the existing version response.
Latest integration 72f97d29 includes main 8d44f069 and recovery 4ce7befa.
The native notes disclosure now uses palette-colored painted arrows; four Qt
checks and refreshed screenshots confirm both states. Exact-CI production build
and unchanged budgets pass (/app 237.2/240 kB).

The subsequent Windows CI timing failure exposed a real synchronous settings
write on the Qt thread. Manual Save now captures/validates on Qt, disables the
form while a non-daemon persistence worker commits, and returns completion/error
through Qt signals. Sidebar navigation/timers remain responsive while the actual
global writer lock is held; geometry persistence defers until that Save finishes.
The handler still returns only after the real durable commit. The old handler
wall-clock test is replaced by actual durability plus this native responsiveness
contract, rather than excluding a UI stall from its measurement. Settings/state
focused checks passed 103. The resulting full Windows agent suite passed 2,076
tests, 1 skipped and 78 subtests (151.33 seconds); the final competing-write
guards passed 11 native checks. These changes retain real atomic persistence.

Main 17ab0ff2 is now integrated at e271cb1f. Its merged changes are confined to
web/help/docs; all 100 help/search/render checks and web typecheck/lint pass.
Exact-CI production build and all unchanged budgets pass: /app 234.4/240 kB,
opponents 175.7/180, builds 187.9/270 and help 150.4/185. The final main
integration changed web/help/docs only; the native suite evidence above remains
applicable. Draft PR #668 is ready for final remote CI and dependency-order review.

No canonical version bump, release tag, signed installer claim, or publication.
The owner coordinates the final accepted Wave 2 version and pushes the tag after
integrated verification. No AI feature/call and no infrastructure changes.
