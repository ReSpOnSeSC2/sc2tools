# In-game scouting window controls

Based on main `296f39c656b36291fe13af14745d91cee955c9db`.
Branch: `codex/fix-in-game-scouting-close`.

The owner reported that the floating scouting report's X did not respond
while StarCraft II had focus, although the separate scouting icon did.
The whole report HWND was intentionally click-through; only the icon had
a separate non-activating native input surface.

The report's X and minimize actions now use the same small input surfaces.
The rest of the report remains click-through. Proxies retain the source's
stylesheet ancestry and checkable state, reject hidden/stale activation,
and preserve `WindowDoesNotAcceptFocus`, `WA_ShowWithoutActivating` and
`WM_MOUSEACTIVATE -> MA_NOACTIVATE`. Close uses the existing saved pin
preference; the scouting icon can reopen the report for the current match.
No change to main-window close-to-tray behavior or other pinned panels.

Verification:

- Real Companion regression failed before the fix because X had no input
  surface; it passed after the fix. Coverage includes close/save/poll/reopen,
  minimize, stale/hidden clicks, Alt-Tab, geometry and shutdown cleanup.
- Windows hidden-HWND tests verify native transparency, no-activation styles
  and actual `WM_MOUSEACTIVATE` reply for both toggle and momentary buttons.
- Related overlay input, Compact scouting, pinned chrome and window chrome
  suites: 49 passing tests. The two hidden-HWND cases also pass with an
  intermediate source-controls parent, matching the report header hierarchy.
- Help registry/content/preview: 29 passing tests; generated index unchanged;
  strict Help-leaf lint and Python compilation pass.
- `screenshots/scouting-close-in-game.png` uses synthetic replay data and
  explicitly registered installed Segoe UI fonts. Default and Protoss source
  and proxy button interiors render identically. Root inspected the capture.
- Independent source review found no remaining blocker.

No StarCraft launch, real foreground-game test, production request, installer
execution, signing, version bump, release or tag was performed. The installed
agent is not modified by this source fix; it needs a subsequent desktop release.
