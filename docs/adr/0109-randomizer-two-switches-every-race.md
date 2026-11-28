# ADR 0109: Randomizer draws with two switches, for every race

Status: Accepted, November 27, 2026. Extends the Randomizer config
(`apps/web/lib/randomizer/config.ts`), its engine and OBS widget, the API's
native randomizer and channel-point reroll, and the desktop card's draw
(`apps/agent/sc2tools_agent/build_checkin/randomizer_draw.py`, ADR 0107).

## Context

- Each matchup had one switch, `enabled`. A Protoss build could be followed
  by its opening Gateway units (`unitRandomizerEnabled`), but units were never
  drawn without a build, and Terran and Zerg drew no units at all.
- The owner asked for the build and unit draws to turn on and off
  independently, for opening units in every race, tailored per matchup and
  taken from what the program already defines, and for a streamer who queued
  Random to get the draw for the race they actually got.
- Three places draw: the web engine behind the OBS widget, the API (which
  picks the build only), and the agent (which repeats the widget's units).
  A stored config is read by all three, and agents back to 0.21 can edit it.

## Decision

- **Two switches, config version 3.** `enabled` is "Draw a build order" and
  `unitRandomizerEnabled` "Draw opening units". A version-3 config reads them
  independently, each off unless saved on. An older config drew units only
  after a Protoss build, so it reads its unit switch as on only when its
  build draw is on in a Protoss matchup: every stored config keeps its
  meaning, and the first save writes version 3. A matchup's own unit draw
  lives in a new `units` block, absent until set up (absent draws nothing).
- **Units after a build, or alone.** With both switches on, units follow the
  drawn build: its pool entry's own settings; a Terran or Zerg entry saved
  without any uses the matchup's; a saved pick no longer in the pool draws
  none. With only the unit draw on, the matchup's `units` draw, from the
  game seed's first values (after a build they take the values after the
  build's two, as before).
- **Where each list comes from.** Protoss keeps its four Gateway units in
  every matchup and `inferGatewayCount`. A Terran or Zerg matchup draws the
  units its own pre-made builds are named for: the names of the definitions
  tagged with that matchup in `build-definitions.generated.json` (the
  catalog its build pool offers), read with the icon registry's unit names
  and short names (`Ling`, `Tank`, `Widow Mine`), keeping the units that
  `presetCatalog.json`'s `unitTechPrerequisites` lists with a single
  structure (Thor, Hellbat and Battlecruiser need two). The nine lists are a
  small table in `openingUnitPools.ts`, and `openingUnitPools.test.ts`
  derives them again from those two files and fails on drift. Every Terran
  and Zerg matchup has units to derive. The per-race list holds what a unit
  is only: id, name, icon and the structure `unitTechPrerequisites` names.
- **A build's units and count.** A new pool entry starts with the units its
  name names (or the whole matchup list when it names none) and draws two
  when those units come from two structures, a two-building opener such as
  Reaper Hellion. Custom builds use their names too, as Protoss custom
  builds always have: the settings list reads build summaries, which carry no
  build order. The streamer can change count, units and odds per build.
- **Random.** The agent latches "Random" on `user.race` all game (Ghost needs
  the choice). The widget and the API read a Random streamer's race from the
  client's own `players[]` entry of the streamer's name, once concrete; two
  entries of that name, or a Random opponent, leave the matchup unknown, so
  nothing is drawn before the race is known and the game key still draws
  once. The desktop loading card is never shown for a Random game (the
  check-in contract, `HIDE_RANDOM`), so it draws nothing there.
- **The server follows the switches.** The native randomizer and the reward
  reroll pick builds, so they need the build draw: with it off they refuse
  (`randomizer_disabled`) and the reroll reward is not offered. Units drawn
  alone are one fixed draw per game; a declared build does not hide them.
- **Budget.** The unit reveal and its unit names load on demand
  (`loadUnitStage`), warmed while games are pending, so `/overlay/[token]`
  loads less up front than before.

## Consequences

- One fixture, `unitDrawParity.json`, now covers every race and mode and runs
  on the web (through the overlay's config step and `gameSpin`) and in the
  agent; `nativeParity.test.ts` checks the API's pick in every mode.
- An agent older than 0.26.0 shows "Enable for this matchup", which in a
  version-3 config turns the build draw alone; 0.26.0 names it **Draw a build
  order**.
- The desktop card reads the settings once per game for units drawn alone
  (one small request), and shows them only when the loading card shows.
- Future catalog builds named for new units change the derived lists; the
  derivation test names the matchup to update.
