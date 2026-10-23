# Wave 3 private desktop scouting checkpoint

Branch `codex/wave3-private-scouting` in isolated worktree
`C:/SC2TOOLS/.worktrees/wave3-private-scouting`, stacked on frozen installer/runtime
`ecb3035e` (dependency-only base `codex/wave3-private-scouting-deps`).

Read full final-plan specs, augments (none), audit and howto for
`agent-private-scouting-card` and dependent `agent-gui-expansion-1`.
Implementation has not started. Root owns final dependency/main integration,
shared focus helpers and merges. Frozen chrome #684 remains clean at `11028908`.

Planned first PR: size-capped device-only current-game scouting brief plus cached
fallback and validated opponent notes; defensive plain-text scouting strip in
loading cards; scouting-only mode; private opponent note after the game; real
broker/device/controller/model/offscreen regressions and desktop-scouting help.
Expansion follows separately: local-only previews, generic placement reset and
search keyboard flow without changing controller business logic, with real Qt
focus/action tests and help/README updates.

No AI features/API calls, new infrastructure, canonical version bump, tag,
release, installer execution or signing. Do not claim live capture protection or
native install without actual platform verification.
