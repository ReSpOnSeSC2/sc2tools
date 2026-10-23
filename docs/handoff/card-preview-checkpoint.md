# Wave 3 card preview/reset/keyboard checkpoint

Isolated branch `codex/wave3-card-previews` in
`C:/SC2TOOLS/.worktrees/wave3-card-previews`. Based on private scouting #691,
then merged green main `441582d0` at `78032e52`. Complete final-plan specification,
augments (none), audit and howto read for `agent-gui-expansion-1`.

## Implemented

- Fixed sample loading/after-game models with three featured builds, Alcyone,
  PreviewOpponent and sample scouting. Use the latest accepted replay's concrete
  race persisted on the upload worker; default ZvP. Older history cannot replace
  a newer race, and a save failure cannot lose the existing check-in callback.
- Visible preview chip and local action interception: no controller, API or
  browser work. Dragging still persists placement. Actual Qt timer closes at
  90 seconds; Escape works while the user remains in this app without a global
  game hotkey. Real cards replace previews immediately and have priority.
- Settings Cards buttons work with check-ins off; generic reset clears every
  host/state card kind, persists off the UI thread and repositions visible cards.
  Three-second reset feedback and queue link use the existing website URL helper.
- Search Enter selects/focuses the top displayed result (featured before More),
  no-match does nothing, Down focuses without selecting, Up returns to search,
  Ctrl+Enter still confirms. Native flags/handles never change and there is no
  explicit activation request. Controller business logic is unchanged.
- Rich build-check-in help, README, Unreleased entries and three reviewed native
  screenshots at `docs/handoff/screenshots/desktop-card-preview-*.png`.

## Final verification

- Integrated full Windows agent: **2,152 passed, 1 platform skip, 78 subtests**
  (163.62 s). Focused native/runner/state suite:187 passed; final actual preview
  suite:18 passed, including real Escape input from Settings.
- The first full run exposed one test's fixed 40 ms wait under build load. It now
  waits for the actual Qt timeout signal with a bounded one-second deadline,
  retaining the active 90-second production timer assertion. No responsiveness
  measurement or production timeout was relaxed.
- Real unsigned PyInstaller one-folder bundle builds, includes the new preview
  module and reports `NotSigned`. Its offline diagnostic paints all five pages,
  Streams and both preview cards through production Settings callbacks with no
  user state/service/network bootstrap. Loading320x340, postgame360x458,
  Settings560x495 screenshots use installed Segoe UI fonts.
- Exact-CI web production build and all unchanged budgets pass: /app234.9/240 kB,
  game423/440, help151.2/185, help article179.4/200. Post-build typecheck, strict
  touched-help lint and all72 help checks pass (70-article registry).

Offscreen tests verify native capture/no-activation requests, not real Windows
foreground state or every capture tool. No AI feature/call, new infrastructure,
production operation, version bump, installer execution, signing, tag or release.
Root owns final remote CI and merge. Next separate desktop pack is
`agent-stream-automation`; its complete specification/augments/howto was read.
