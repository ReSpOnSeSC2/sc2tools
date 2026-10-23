# Wave 2 desktop runtime checkpoint

Scope: agent-window-tray-folders, agent-match-aware, agent-gui-polish-3.
Branch: codex/wave2-agent-runtime, based on pairing recovery / calm sync PR #661.

Implemented native relaunch activation; shared timed pause and tray routing;
redirected folder discovery, metadata rows and instant Undo; one structured status
model/card/sidebar/tray dot; match-aware history/archive/capture gating; lower
priority performance profiles; safe-time installer scheduling and persistent
update notes/actions. Help leaves, README, and Unreleased notes accompany them.

Validation at checkpoint 0f24e703: full Windows agent suite 2,058 passed,
1 skipped, 78 subtests; help/search/render suites 100 passed; web typecheck and
lint passed; production build with exact CI flags and every unchanged bundle
budget passed. Native screenshots in docs/screenshots/agent-runtime-*.png show
Dashboard, notes, and Settings. Activation is checked across two actual processes;
real parse-worker process priority, queue/archive/capture holds, durable timed
resume, folder Undo, and Qt wheel hit testing are covered.

Service notice parsing from the announcements work was cherry-picked separately
as 9f7cc88c. Its native client uses a separate plain-text card, safe relative links,
tray menu/one toast per hash, and expiry without another network check. The 24
focused updater/notice/native tests pass. Final integrated-main checks remain
before opening the draft PR.
No canonical version bump, release tag, signed installer claim, or publication.
The owner coordinates the final accepted Wave 2 version and pushes the tag after
integrated verification. No AI feature/call and no infrastructure changes.
