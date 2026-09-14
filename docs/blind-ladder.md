# Blind Ladder

Blind Ladder is an optional native screen cover in the Windows desktop agent.
It is designed for players who want to start each match without the expectations
that an opponent's name, rank, rating or chat can create.

The master switch lives on the agent's **Dashboard** and in **Settings → Blind
Ladder**. Both controls change the same saved setting immediately. Fresh installs
and upgrades default to off. Turning it off removes the covers; replay syncing
and analysis continue.

## First use

1. Run the Windows desktop GUI and open SC2 in windowed or borderless mode.
   Exclusive fullscreen is unsupported. A fullscreen-sized game window needs
   an explicit borderless confirmation because its size alone cannot establish
   which rendering mode SC2 uses.
2. Click **Turn Blind Ladder on**. The first-run status says that coverage setup
   is needed; enabling the setting alone is not a claim that the screen is
   protected.
3. Click **Set up coverage…**, available directly on the Dashboard and in
   Settings. Check the loading-card positions, the entire chat area and the
   score-screen area against your actual SC2 window. Save only after verifying
   coverage. Use **Draw mode** if the controls obscure an area: the controls
   collapse while you drag and return afterward. **Show controls** restores
   them without drawing, and **Escape** cancels. The setup button becomes
   **Adjust coverage…** afterward.
4. Queue after setup. Recheck coverage after changing SC2's interface scale,
   window shape, monitor, resolution or display scaling. A calibration for one
   aspect ratio must not silently be treated as verified for another.

**Ctrl+Shift+F9 is emergency off.** It removes the covers through the same saved
off-setting path. The shortcut never enables Blind Ladder. The normal GUI toggle
remains available if the hotkey cannot be registered or a setting cannot be saved.

## What appears on screen

| SC2 state | Blind Ladder behavior |
| --- | --- |
| Not running, minimized or not foreground | No covers over other applications. Status reports the current availability. |
| Before a match / menus | Calibrated loading panels remain armed over their positions so coverage is already present when loading begins. They may obscure menu content, though clicks pass through. Turn Blind Ladder off when ordinary menu browsing is needed. |
| Loading | The default is an opaque full-window curtain. It hides native names, clan tags, portraits, rank badges and ratings. A neutral opponent-race label uses only reliable current SC2 data. Random remains Random; missing or ambiguous data is shown as unavailable rather than inferred from past games. |
| Gameplay | Loading coverage releases after the native game view is confirmed. The configured chat area remains covered, including opponents' messages, your own messages, typed chat and system text inside that area. |
| Native top-right player panel | SC2's existing panel and its button remain usable and uncovered. Opening the panel is the deliberate reveal action; Blind Ladder does not replace it or intercept its controls. |
| Score screen | The configured score area remains covered so a result screen does not immediately expose player identity or ratings. Turn the master switch off to inspect it normally. |
| Watching a replay | The shield releases when the API confirms a replay in the game view. |

The default rectangles are starting points, not measured coverage for every SC2
layout. Any text outside the configured chat rectangle remains visible. Verify
the full native chat log and input area, rather than only one example line.

## Boundaries

The agent uses SC2's existing local client API and ordinary Windows cover windows.
It does not modify game files, patch the renderer, inject code, read game memory,
or change gameplay input. Cover windows do not take keyboard focus; normal game
clicks pass through. Covering a message does not delete it or prevent SC2 from
sending or receiving chat.

This feature controls the native game display. SC2Tools browser widgets, scouting
voice, dashboard pages, OBS previews, chat bots and stream chat retain their own
settings. Those surfaces can still reveal identity or ratings. An OBS source by
itself cannot hide anything on the player's game monitor; conversely, whether
these desktop covers appear in an OBS capture depends on its capture method.

The local API is a polling signal, not a frame-perfect renderer hook. Armed
loading panels reduce the transition gap, but the implementation does not promise
zero exposed frames on every machine or layout. If SC2 state becomes unavailable,
the runtime reports that condition and keeps conservative panels rather than
silently treating the last successful API response as current. A full loading
curtain is bounded after API loss so it cannot indefinitely conceal gameplay.

Blind Ladder requires the Windows GUI. Console/tray-only execution reports it as
unavailable even when the saved preference is on. Enabling or coverage edits that
cannot be saved retain the previous setting. Turning protection off removes the
covers for the current run even if saving fails; the UI then shows **Save off
setting** so the user can retry before restarting. The previous durable setting
remains unchanged until that retry succeeds.

## Validation status

Automated checks exercise the pure state policy, native window geometry and
foreground checks, real Qt controls in offscreen mode, configuration validation,
atomic persistence, calibration acceptance/cancellation and disk-failure rollback.
The feature-specific GUI tests use the real runner and state-save path.

SC2 itself was **not running during the development validation on September 13,
2026**. Automated/offscreen checks do not establish coverage of the real loading
screen or the first gameplay frame. A live SC2 check remains necessary before
claiming the native screen behavior is verified.

### Manual live checklist

- [ ] Start with Blind Ladder off; verify the native game display and chat are unchanged.
- [ ] Use windowed/borderless SC2; complete coverage setup and verify the status.
- [ ] Verify armed panels cover both player-card positions before queue/loading.
- [ ] Load a real match; inspect the entire loading window for names, badges,
  portraits, clan tags and rating leaks. Confirm the race label reflects only the
  current match and handles Random/unavailable data honestly.
- [ ] Verify the loading curtain clears promptly when gameplay begins and input
  focus stays in SC2.
- [ ] Check opponent, own, typed and system chat across multiple lines; expand or
  reposition the configured chat mask if any text escapes it.
- [ ] Open and close SC2's normal top-right player panel; verify it stays usable
  as the deliberate reveal route.
- [ ] Finish a match; verify score coverage, then disable the mode to inspect the
  result normally.
- [ ] Alt-tab, minimize, resize and move SC2 between monitors with different DPI;
  verify covers never obscure another application and layout changes request
  verification where needed.
- [ ] Test **Ctrl+Shift+F9**, the GUI off toggle, restart persistence and GUI exit;
  verify covers disappear and the off-setting remains saved.
- [ ] Check a long loading screen, local API interruption/recovery, quick requeue
  and replay playback. Verify stale opponent information is never reused as a
  current race label.
- [ ] Inspect OBS preview/audio and any open SC2Tools browser surfaces separately
  if the aim is to avoid all opponent information during play.
