# ADR 0078: The desktop agent takes every colour and size from one token set, and a skin changes only its accent

Status: Accepted, November 10, 2026. Implemented in the desktop agent with the
first part of the interface refresh (agent 0.25.0, not yet published). No
setting, file format or dependency change.

## Context

- The owner asked for an agent that feels "modern and sleek" and keeps "the
  zerg/protoss/terran esthetic".
- The agent is PySide6 Qt Widgets. Its colours lived in `ui/theme.py` and
  `ui/palette.py`, but the race skins in `ui/race_visuals.py` repainted every
  card, panel and button border in the race colour, and about 46
  `setStyleSheet` calls in 17 files set their own colours and font sizes.
- A gallery of every main surface in the four skins at two sizes
  (`apps/agent/tests/manual/interface_gallery.py`) showed what dated the
  look: a purple gradient bezel around a bordered sidebar and a bordered page,
  each holding bordered cards; every button filled and outlined alike; race
  skins that recoloured borders but left the default purple on the selected
  page, scroll bars and headings; letter-spaced capitals and only two type
  sizes; stock Qt menu arrows and squeezed help buttons.
- Qt style sheets have no shadows, no transitions and no variables. A skin is
  applied by appending its rules to the application style sheet and to every
  widget that carries its own (`raceBaseStyle` in `gui.py`, and the Companion
  panels). Appended rules win only over rules of equal or lower specificity.
- The website's `docs/design-system.md` describes the site and says the
  desktop has its own constraints.

## Decision

1. **One token set in `ui/theme.py`** for colour, type, spacing, corner
   radius, elevation and motion. Every style sheet is built from it. Status
   colours stay in `ui/palette.py`, which the tray icon draws with PIL outside
   Qt, and `theme.py` re-exports them.
2. **Surfaces and text are shared by all skins.** Elevation is tone, not
   shadow: canvas, page, card and overlay are each one step lighter. A skin
   (`theme.SKINS`) changes the window canvas tint, one accent family (accent,
   hover, pressed, the text on it, and the selected and progress tints derived
   from it) and the focus ring. Race identity is that accent, one small
   painted mark beside the name (`ui/brand_mark.py`) and the border artwork
   the agent already draws; no panel gets a race-coloured frame.
3. **A skin's style sheet is the colour-only difference from the default.**
   `theme.skin_layer(name)` renders the same template in both skins and keeps
   the declarations that differ, so appending it can recolour but never move,
   resize or re-font a widget. The default skin adds nothing.
4. **The system face and one type scale**: Segoe UI Variable Text on
   Windows 11, Segoe UI before it, at 11, 12, 13, 15, 18, 24 and 40 px. No
   font file ships.
5. **Contrast is a test.** Every text token reads at 4.5:1 or more on every
   surface it sits on in every skin; focus rings and field outlines read at
   3:1.
6. **Motion is short and follows Windows.** The border expansion lasts
   0.3 s and plays only when the player's animation choice and Windows'
   Animation effects (`SPI_GETCLIENTAREAANIMATION`) are both on.
7. **Converted files are guarded.** `tests/test_ui_token_guard.py` fails when a
   converted file sets a colour or font size itself. Each part of the refresh
   adds the files it converts; a large file can be listed by function until
   the rest of it is converted.

## Consequences

- Restyling a surface means naming its widgets and styling them in
  `theme.py`, or building its style sheet from tokens there. A colour or size
  typed into a converted file fails the guard.
- Race skins stay in step with the default: a new rule that uses an accent
  recolours in every skin without a second copy.
- Until the other pages, Companion, the floating cards and the Streams page
  are converted (parts V1b to V1e), they keep their own style sheets. They
  already read the shared tokens, so they take the new surfaces;
  `ACCENT_CYAN` and `CONSOLE_GRADIENT` remain only for them, and
  `race_visuals.css_for_skin` recolours Companion's accents in race skins.
- Old token names keep new meanings: `BORDER_STRONG` is a quiet divider and
  `BUTTON_CHECKED` the light selected tint. A field outline takes
  `BORDER_CONTROL` and a filled main action takes `ACCENT` with `ON_ACCENT`
  text, as the check-in cards and Companion's fields now do.
- The offscreen gallery renders Segoe UI; Segoe UI Variable is drawn only on
  Windows 11 itself.

## Not decided here

- Whether translucency and click-through of the in-game windows look right
  with the new tokens. That needs the installed agent over a running game.
