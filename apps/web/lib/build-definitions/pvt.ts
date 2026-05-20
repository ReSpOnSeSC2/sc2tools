import type { BuildDefinition } from "../build-definitions";

export const PVT_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - 2 Base Templar (Reactive/Delayed 3rd)",
    description:
      "Detected if a Templar Archives is built (required for HighTemplar / Psionic Storm) AND it finishes BEFORE the third Nexus is taken AND the player has 4-6 Gateways by 7:30 -- a reactive 2-base High Templar / Storm timing with a delayed 3rd. A hallucinated High Templar is NOT enough; the Templar Archives must actually exist.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - 2 Gate Blink (Fast 3rd Nexus)",
    description:
      "Detected if Blink is researched by 8:00, the player has taken 3+ Nexuses, exactly 2 Gateways were STARTED before the 3rd Nexus, AND a Robotics Facility is up by 8:00 -- a fast-3rd 2-Gate Blink style. The gate count is measured against the 3rd Nexus's start time, not a fixed 7:30 cutoff, so a player can add more Gateways after taking the 3rd Nexus without flipping the label to 3 or 4 Gate Blink.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - 3 Gate Blink (Macro)",
    description:
      "Detected if Twilight Council goes BEFORE Robo and Stargate, Blink is researched by 9:00, AND exactly 3 Gateways were STARTED before the 3rd Nexus -- a macro 3-Gate Blink style. Counting gates before the 3rd Nexus (not a fixed 7:30 cutoff) means a player who takes the 3rd Nexus fast and then adds more Gateways still classifies as 3 Gate Blink, while a player who delays the 3rd Nexus to push out 4+ Gateways gets labelled 4 Gate Blink.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - 3 Gate Charge Opener",
    description:
      "Detected if Charge is researched by 9:00 AND Twilight Council was built BEFORE Robotics Facility AND BEFORE Stargate -- a Twilight-first 3-Gate Charge opener.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - 4 Gate Blink",
    description:
      "Detected if Twilight Council goes BEFORE Robo and Stargate, Blink is researched by 9:00, AND 4+ Gateways were STARTED before the 3rd Nexus -- a 4-Gate Blink Stalker timing. The gate count is measured against the 3rd Nexus's start time, so a player who delays the 3rd Nexus while adding Gateways gets this label, while a player who takes the 3rd Nexus fast and then adds Gateways gets the lower-count Blink label that matches what was committed pre-expansion.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - 7 Gate Blink All-in",
    description:
      "Detected if Blink is researched by 9:00 AND 6+ Gateways exist by 9:00 AND the 5th Gateway was STARTED before the 3rd Nexus was STARTED -- a heavy multi-Gate Blink all-in. \"Taken\" the 3rd Nexus means construction was initiated, not finished: a player can drop the 3rd Nexus and add Gateways while it is still building and those Gateways are still macro reinforcement, not all-in production. The build is excluded if the 3rd Nexus broke ground before the 5th Gateway.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - 8 Gate Charge All-in",
    description:
      "Detected if Charge is researched by 9:00 AND 7+ Gateways exist by 7:30 AND fewer than 3 Nexuses have been taken -- a 2-base mass-Gate Chargelot all-in.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - DT Drop",
    description:
      "Detected if a Dark Shrine is started by 3:45 AND a Robotics Facility is up by 4:00 AND at least one real (non-hallucinated) Dark Templar exists on the field by 4:30 AND a Warp Prism is on the field by 4:45 -- a fast tactical PvT DT drop. The cutoffs are calibrated against a real PvT DT Drop replay (Peruano, Taito Citadel LE 2026-05-11: Shrine 3:13, Robo 3:32, DT 3:51, Prism 4:11) with ~30 seconds of buffer per signal. Slower variants that miss these windows are Robo First or late-tech DT support builds, not drop openers.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - Macro Transition (Unclassified)",
    description:
      "PvT catch-all: the game reached the macro phase but did not match a more specific PvT pattern.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - Phoenix Opener",
    description:
      "Detected if a Stargate is built, 1+ real (non-hallucinated) Phoenix is on the field by 7:00, AND the player's second Gateway was built BEFORE the Robotics Facility -- a pure Phoenix opener. Hallucinated Phoenix from Sentries do NOT count.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - Phoenix into Robo",
    description:
      "Detected if a Stargate is built, 1+ real (non-hallucinated) Phoenix is on the field by 7:00, AND a Robotics Facility is up by 8:00 -- a Phoenix opener that transitions into Robo tech. A Sentry's hallucinated Phoenix does NOT trigger this build.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - Proxy Void Ray/Stargate",
    description:
      "Detected if a Stargate is built before the natural Nexus within 50 units of the OPPONENT's main -- a proxied Stargate (Void Ray) timing.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - Stargate into Charge",
    description:
      "Detected if a Stargate is built before any Twilight Council (the Stargate unit produced — Phoenix / Oracle / Void Ray — does NOT matter), a Twilight Council is built AFTER the Stargate, AND the FIRST upgrade researched out of the Twilight Council is Charge (i.e. Charge starts before Resonating Glaives and before Blink). The build can resolve as a 2-base Chargelot timing OR transition into a 3-base Charge macro game — the rule keys on the Stargate-then-Charge opening only and does NOT require an all-in commitment. Disqualified if a Robotics Facility (or an Immortal / Robotics Bay) lands BEFORE the Twilight Council — those replays are Phoenix into Robo / Robo First, not Twilight-led.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - Stargate into Glaives",
    description:
      "Detected if a Stargate is built before any Twilight Council (typically with Phoenix harass, but the Stargate unit does NOT matter), a Twilight Council is built AFTER the Stargate, AND the FIRST upgrade researched out of the Twilight Council is Resonating Glaives (Glaives starts before Blink and before Charge). The old-school Stargate-Phoenix into Glaive Adept midgame timing. Disqualified if a Robotics Facility (or an Immortal / Robotics Bay) lands BEFORE the Twilight Council — those replays are Phoenix into Robo, not Twilight-led.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - Stargate into Blink",
    description:
      "Detected if a Stargate is built before any Twilight Council (the Stargate unit produced does NOT matter), a Twilight Council is built AFTER the Stargate, AND the FIRST upgrade researched out of the Twilight Council is Blink (i.e. Blink starts before Resonating Glaives and before Charge). Stargate harass into Blink Stalker macro/midgame. Disqualified if a Robotics Facility (or an Immortal / Robotics Bay) lands BEFORE the Twilight Council — those replays are Phoenix into Robo, not Twilight-led.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - Stargate Opener",
    description:
      "Catch-all: detected when a Stargate is the FIRST tech building after the Cybernetics Core (before Twilight Council and before Robotics Facility) AND the build did NOT match any more specific Stargate-prefixed PvT rule (Proxy Void Ray / Stargate into Charge / Glaives / Blink / Phoenix into Robo / Phoenix Opener). A custom build rule can refine this further.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - Robo First",
    description:
      "Detected if a Robotics Facility is built before 6:30 AND it is the FIRST tech building (before any Twilight Council) AND NO Stargate has been built at any point. A Stargate — even one built AFTER the Robo — makes the build a Robo+Stargate hybrid that Phoenix into Robo / Stargate Opener cover instead.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - Standard Charge Macro",
    description:
      "Detected if Charge is researched by 9:00 AND the player has taken 3+ Nexuses AND NO Stargate has been built — the pure Gateway / Twilight 3-base Chargelot macro. Any Stargate (at any point) makes the build a hybrid Stargate composition; those replays land under Stargate into Charge / Phoenix into Robo / Stargate Opener instead.",
  },
];
