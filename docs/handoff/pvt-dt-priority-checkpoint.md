# PvT Dark Templar opening priority checkpoint

2026-10-25. Branch `codex/fix-pvt-dark-templar-priority`, preserved in
`.worktrees/wave3-private-scouting`, initially based on current main.
This is source work for the user's reported PvT Charge-first misclassification.
No production replay reanalysis or data mutation is authorized or performed.

## Detection contract

- The personal PvT tree previously had DT Drop but no ground DT Rush branch.
  It could classify an early Shrine/DT opening by a later Charge upgrade and
  fast third. The generic `Protoss - DT Rush` label belongs to the opponent
  surface and is not reused for the player's matchup-specific build.
- New `PvT - DT Rush`: Twilight is first tech before Robo/Stargate; Dark Shrine
  starts after Twilight and by 5:00; at least one real DT appears by 6:00.
  Existing DT Drop is checked first with its unchanged tighter Shrine/Robo/
  DT/real-Prism windows. Hallucinated and prerequisite-missing units do not
  supply either proof.
- Early Shrine commitment excludes every Twilight-first Charge variant:
  8 Gate Charge All-in, Charge First (Fast 3rd Nexus), Standard Charge Macro
  and 3 Gate Charge Opener. Without real DT rush proof the tree keeps an
  appropriate other opener or honest unclassified result. The prior
  Shrine/Shadow Stride/no-DT Charge expectation is intentionally corrected to
  the user's explicit criterion; Shadow Stride is still not Stalker Blink.
- A Shrine started after the existing five-minute opening window does not
  rewrite Charge macro as a DT rush. Stargate/Robo openings, other matchups,
  custom build precedence, active preset policy and manual check-in are not
  broadened by this fix.
- Building clocks are construction starts; the extractor does not reliably
  retain constructed Twilight completion. No exact finish or start-plus-36
  inference is invented. Early real DTs provide causal tech-completion proof.

## Evidence and verification plan

The reported case is an 8:12 PvT on Eternity's Edge LE with a proxy Shrine
displayed at 3:17 and DT rows around 3:54–4:04. The exact raw replay/debug has
not been recovered locally. The regression fixture is clearly synthetic and
uses raw engine building-start/unit-appearance clocks, not display rewinds.

Source tests cover all Charge variants, real ground/drop priority, missing/
late/hallucinated transport, cutoff boundaries, missing tech, late transition,
canonical/native compatibility imports, and private/global precedence. A shared
15-case fixture is also evaluated from the verified built Pyodide archive.
Source catalogs and public definition/name/variant indices are regenerated.

Verification: 519 focused CPython/native checks pass across PvT/PvZ, real-unit
prerequisites, preset policy and generated catalogs; 12 web definition parity
checks pass. Strict lint passes the changed web wording and engine test.

The preserved, verified browser bundle `25b300818c31d41b` produced the actual
regression RED: `ground-dt-before-charge` returned Charge First rather than
DT Rush. Rebuilding the same engine version 1.6.12 produced
`fc21ebe5bf52a53c`; all 15 shared raw-clock cases then pass in the verified
Pyodide archive. Full built-engine checks: 10 pass, one optional CPython golden
envelope comparison is skipped because `INSTANT_GOLDEN_DIR` was not supplied.
Manifest digest checks, real replay smoke parse, Archon Drop and active-policy
parity also pass. The normal builder smoke parsed a 142939-byte payload with
Python 3.14.2, assembling 223 files including 79 compiled Python files.

Generated preset release hash is
`4c69cd9f75b47d2532b81b30890ac9ce05bd5e32dc98846fc43431232b70765d`.
Public catalogs contain 189 engine labels and 198 build variant IDs.

Engine version remains 1.6.12 with a normal content-addressed hash change.
No version, tag, installer or binary release is part of this task. No production
reanalysis is performed. Commit/integration/CI and production delivery remain
root-owned gates; the exact reported game is still awaiting its debug URL.
