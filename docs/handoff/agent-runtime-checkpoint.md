# Wave 2 desktop runtime checkpoint

Scope: agent-window-tray-folders, agent-match-aware, agent-gui-polish-3.
Branch: codex/wave2-agent-runtime, based on pairing recovery / calm sync PR #661.

Implemented native relaunch activation; shared timed pause and tray routing;
redirected folder discovery, metadata rows and instant Undo; one structured status
model/card/sidebar/tray dot; match-aware history/archive/capture gating; lower
priority performance profiles; safe-time installer scheduling and persistent
update notes/actions. Help leaves, README, and Unreleased notes accompany them.

Validation is in progress. The first full Windows offscreen run passed 2,048
tests and exposed two test/activation issues: activation now acknowledges show
across two real processes, and folder tests distinguish an empty reset from
explicitly removing the last folder. Focused rechecks passed. Final exact-head
results and screenshots will replace this paragraph before the draft PR opens.

No canonical version bump, release tag, signed installer claim, or publication.
The owner coordinates the final accepted Wave 2 version and pushes the tag after
integrated verification. No AI feature/call and no infrastructure changes.
