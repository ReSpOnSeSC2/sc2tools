# ADR 0107: The Randomizer draw on the desktop card

Status: Accepted, November 27, 2026. Extends the build check-in loading card
(`apps/agent/sc2tools_agent/build_checkin/`, `ui/build_checkin_cards.py`) and
the Randomizer widget (`apps/web/components/overlay/widgets/RandomizerWidget.tsx`).

## Context

- The server saves one Randomizer pick per game. The OBS widget then draws the
  opening Gateway units of that build in the browser, from a seed made of the
  matchup and the game key, and saves nothing about them.
- The desktop loading card showed the saved build only. An earlier native
  popup with its own draw engine and animation was removed after it lagged
  the owner's PC; nothing was measured then.
- Measured offscreen for this change (paints and timer wake-ups per minute):
  the loading card 0 and 60 (its once-a-second topmost re-assert); the end
  card 0 and 60, but 10,800 paints while "Checking your replay" showed an
  animated progress bar; the overlay input's focus poll 384 wake-ups, each
  asking Windows for the foreground process, even with no overlay open; the
  Companion's Randomizer page 306 paints while open, rebuilding an unchanged
  pool every 3 seconds. The widget's unit reveal kept re-rendering 16 times
  after both Gateways had locked.

## Decision

1. The card shows the draw as a still under the saved pick: the build's first
   steps, then one opening unit or the pair of a 2 Gate build. It repeats the
   widget's seeded draw in the agent (`build_checkin/randomizer_draw.py`)
   instead of rolling again or saving units on the server. The same game shows
   the same units on stream and on screen, with no API change. One fixture next
   to the web engine (`lib/randomizer/__tests__/unitDrawParity.json`) is
   checked by the web engine through the widget's own `gameSpin` and by the
   agent, so a change to either side fails a test.
2. The draw is read once per game and pick, off the controller's thread, with
   the Companion client (`randomizer_draw`: the pool's unit settings for a
   Protoss matchup, a custom build's steps). A failed read is tried once more;
   until then the card keeps the build name. A reroll is a new pick.
3. Steps come from a custom build's reference build order, else its older
   step list. Catalog builds store no steps, so they show none; nothing is
   invented.
4. A card never animates. A waiting state is a line of text. A budget test
   (`tests/test_card_paint_budget.py`) fails when a shown card repaints after
   it settles or wakes more than once a second.
5. The overlay focus poll runs only while a display-only surface is up; the
   Show event of any watched surface restarts it.

## Consequences

- If the widget's spin changes the order in which it uses the seeded values,
  the parity fixture and the agent's copy change in the same pull request.
- The card cannot show units for a pick made outside the pool (the widget
  shows none either), and shows no steps for catalog builds.
- The topmost re-assert still wakes a shown card once a second; whether
  re-asserting over a fullscreen game affects its frame rate is for the owner
  to check in StarCraft.
