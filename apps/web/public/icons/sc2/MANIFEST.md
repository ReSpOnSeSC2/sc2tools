# SC2 Overlay - Icon Pack

This directory holds the icons the stream overlay displays for races,
leagues, buildings, units, upgrades, and match results.

The overlay's icon system is **graceful**: if a file is missing, the
existing text/emoji fallback shows through automatically. You can
populate this folder a few icons at a time without breaking anything.

---

## Directory layout

```
icons/
  races/        zerg.png  protoss.png  terran.png  random.png
  leagues/      bronze.png  silver.png  gold.png  platinum.png
                diamond.png  master.png  grandmaster.png
  buildings/    spawningpool.png  hatchery.png  roachwarren.png
                gateway.png  nexus.png  stargate.png
                barracks.png  factory.png  starport.png
                ... (use the SC2 building's name in lower-case, no spaces)
  units/        zergling.png  baneling.png  roach.png  hydralisk.png
                zealot.png  stalker.png  adept.png  immortal.png
                marine.png  marauder.png  reaper.png  hellion.png
                ... (one .png per unit, lower-case name, no spaces)
  upgrades/     blink.png  charge.png  glaive.png  speed.png  ...
  result/       victory.png  defeat.png  tie.png
  misc/         cheese.png  fire.png  rampage.png  mmr-up.png  mmr-down.png
```

## Naming convention

* Lower-case
* No spaces (use solid words: `spawningpool`, not `spawning_pool` or `Spawning Pool`)
* `.png` with transparent background recommended
* Recommended size: **64x64** (the overlay scales them down to ~28-32 px)
* Higher res is fine; the browser scales them

If you want to use a different naming scheme, edit `icon-registry.js`
in this folder's parent (`SC2-Overlay/icon-registry.js`) -- the path
strings in that file are the source of truth.

## Sourcing icons

You have a few options, in rough order of legal cleanliness for a
personal stream:

1. **Extract them from your own SC2 install** with a community tool
   like the SC2 Editor or `MPQEditor`. These are your assets to use
   on your own stream.

2. **Liquipedia** (https://liquipedia.net/starcraft2/) hosts icons for
   every unit and building, attributed under CC-BY-SA. Right-click,
   save image, rename to match the table above.

3. **Spawning Tool** (https://lotv.spawningtool.com/) and similar
   community sites maintain unit and building icons.

4. **Community icon packs** on GitHub (search "SC2 unit icons" or
   "starcraft 2 icon pack"). Some are MIT-licensed sprite sheets you
   can split.

5. **Blizzard's press kit** if available, for race/league badges.

The overlay does not ship with Blizzard's copyrighted icons -- you
provide them. The mapping logic, sizing, fallback handling, and
animation all work without any icon files at all (text/emoji fallback).

## What gets used where

| Widget                        | Icons displayed                                |
|-------------------------------|------------------------------------------------|
| Match Result                  | Your race + opponent race                      |
| Opponent Detected             | Opponent race (if known)                       |
| Rematch                       | Opponent race                                  |
| Cheese History                | misc/cheese.png (or warning glyph fallback)    |
| Favorite Opening (F1)         | 1-2 strategy icons (e.g. SpawningPool + Ling)  |
| Best Answer (F2)              | 1-2 of YOUR build's icons                      |
| Post-Game Strategy Reveal (F3)| What the opponent actually did                 |
| Streak                        | misc/fire.png / misc/rampage.png               |
| Rank Change                   | leagues/<league>.png                           |
| MMR Delta                     | misc/mmr-up.png / misc/mmr-down.png            |
| Meta Check (F5)               | The most-faced strategy's icons                |

## Strategy → icon mapping

The mapping is defined in `SC2-Overlay/icon-registry.js`. It works in
two stages:

1. An **explicit table** for the most common named strategies
   (e.g. `"Zerg - 12 Pool"` -> `["buildings/spawningpool.png", "units/zergling.png"]`).
2. A **keyword fallback** -- if a strategy isn't in the table, the
   registry scans the strategy's name for known unit/building keywords
   and assembles icons from whatever it finds. This means your custom
   builds (defined in `data/custom_builds.json`) get icons too,
   automatically, as long as the build name mentions recognizable
   units or structures.

Edit `icon-registry.js` to add explicit entries for any strategies
where the keyword fallback picks the wrong icon.
