# ADR 0097: Agent identity cards show name-matched records, marked approximate

Status: Accepted, November 23, 2026. Narrows how the agent applies the
exact-identity rule; the scouting report rules in ADR 0077
(`docs/adr/0077-game-start-scouting-recent-builds.md`) are unchanged.

## Context

- The cloud enriches each live game with your record against the opponent
  (`streamerHistory.headToHead`). It finds the opponent's row by SC2Pulse
  character id (Tier A), then by toon handle (Tier B), then by display name and
  race (Tier C), and reports `opponentIdentityMatched: false` for Tier C.
- The agent's Compact bar and pinned opponent panel dropped the record whenever
  that flag was false, while the OBS scouting widget shows it. Players saw dashes
  under YOUR RECORD and YOUR WIN RATE against opponents they had played many
  times.
- The live envelope never carried the opponent's toon handle, so Tier B could
  not run, and the agent's SC2Pulse lookup compared live region labels ("US",
  "EU") against region numbers, so the server's own account never won a tie and
  no match ever reached confidence 1.0.
- Barcode names (`IIIIIIIIIIII`) are shared by many accounts. A name match picks
  the most-played row with that name, which is usually someone else.
- SC2Pulse's name search returns every match (450 for "Bob", over 9,000 for a
  barcode), but the lookup scored only the first ten. Scored that way, a sample
  of real ladder opponents put the wrong barcode account first at full
  confidence, and an exact namesake on the same server who mains another race
  lost only the race bonus, so an off-race game could look certain.

## Decision

1. The SC2Pulse lookup normalises region labels and codes before scoring and
   labelling, scores every search hit, and records the chosen character's toon
   handle (`<region>-S2-<realm>-<battlenetId>`).
2. Confidence 1.0 means the exact name on the streamer's server with the hinted
   race, no equally scored namesake, and no other account with that exact name on
   that server among all hits, whatever its race. The live bridge sends the
   handle as `opponent.toonHandle` only at confidence 1.0 and only when the name
   is not a barcode. The handle never rides inside `opponent.profile`.
3. When the cloud matched only by display name, the identity cards show its
   record with a leading `≈` and a tooltip saying it came from the display name.
   Barcode names keep dashes. The record is held apart from `headToHead`, so the
   scouting voice, notes, recent builds and the game-start report still use only
   an exact account. A history whose `oppName` is a different player is still
   discarded entirely.

## Consequences

- Exact matches become far more common: the cloud can key the row by its toon
  handle even when the row has no SC2Pulse character id yet, and notes, opponent
  links and stream titles see the same exact account.
- A name-matched record can include games against another player who used the
  name. The `≈` mark and tooltip say so; the voice report never reads it.
- Barcode opponents without an exact match still show dashes on the agent while
  the OBS widget shows the name-matched record. Aligning the overlay is a
  separate decision.
