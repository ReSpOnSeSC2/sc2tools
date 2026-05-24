import type { BuildDefinition } from "../build-definitions";

export const PVT_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - 2 Base Templar (Reactive/Delayed 3rd)",
    description:
      "Detected if Twilight Council is the FIRST tech building (before any Robotics Facility AND before any Stargate), a Templar Archives finishes BEFORE the third Nexus is taken, AND the player has 4-6 Gateways by 7:30 -- a reactive 2-base High Templar / Storm timing with a delayed 3rd. The Twilight-first ordering guard keeps Robo-first openers that add a late TA for Storm support off this label (those fall through to Robo First). A hallucinated High Templar is NOT enough; the Templar Archives must actually exist.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - 2 Gate Blink (Fast 3rd Nexus)",
    description:
      "Detected if Twilight Council is the FIRST tech building (before Robo AND Stargate), Blink is researched by 8:00, the player has taken 3+ Nexuses, exactly 2 Gateways were STARTED before the 3rd Nexus, AND a Robotics Facility is up by 8:00 -- a fast-3rd 2-Gate Blink style with Robo follow-up for Observer / Immortal support. The Twilight-first ordering keeps Robo-first openers with a midgame Blink tech-switch off this label. The gate count is measured against the 3rd Nexus's start time, not a fixed 7:30 cutoff, so a player can add more Gateways after taking the 3rd Nexus without flipping the label to 3 or 4 Gate Blink.",
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
      "Detected if Twilight Council is the FIRST tech building (before Robo AND Stargate), Blink is researched by 9:00, 6+ Gateways exist by 9:00, the 5th Gateway was STARTED before the 3rd Nexus was STARTED, AND no 3rd Nexus was STARTED before 6:00 -- a heavy Twilight-first multi-Gate Blink all-in. The Twilight-first guard keeps Robo-first openers with 6+ Gateways + late Blink off this label (those fall through to Robo First). \"Taken\" the 3rd Nexus means construction was initiated, not finished: a player can drop a LATE 3rd Nexus (6:00 or later) and add Gateways while it is still building and those Gateways are still macro reinforcement, not all-in production. The build is excluded if the 3rd Nexus broke ground before the 5th Gateway, OR if any 3rd Nexus was taken before 6:00 (a fast 3rd Nexus is a macro commitment, so those builds fall through to the 3/4 Gate Blink (Macro) labels). A DT Drop opener that later macros into a multi-Gate Blink composition is also excluded -- the DT Drop signature is checked first.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - 8 Gate Charge All-in",
    description:
      "Detected if Twilight Council is the FIRST tech building (before Robo AND Stargate), Charge is researched by 9:00, 7+ Gateways exist by 7:30, AND fewer than 3 Nexuses have been taken -- a 2-base Twilight-first mass-Gate Chargelot all-in. The Twilight-first guard keeps Robo-first openers with 7+ Gateways + late Charge off this label (those fall through to Robo First).",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - DT Drop",
    description:
      "Detected if a Dark Shrine is started by 4:15 AND a Robotics Facility is up by 4:30 AND at least one real (non-hallucinated) Dark Templar exists on the field by 5:00 AND a Warp Prism is on the field by 5:15 -- a fast tactical PvT DT drop. The cutoffs are calibrated against a real PvT DT Drop replay (Peruano, Taito Citadel LE 2026-05-11: Shrine 3:13, Robo 3:32, DT 3:51, Prism 4:11) with ~60 seconds of buffer per signal so slower variants still classify. Slower openers that miss these windows are Robo First or late-tech DT support builds, not drop openers.",
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
      "Detected if Stargate is the FIRST tech building (before Robo AND Twilight), 1+ real (non-hallucinated) Phoenix is on the field by 7:00, AND the player's second Gateway was built BEFORE the Robotics Facility -- a pure Stargate-first Phoenix opener. The Stargate-first ordering keeps Robo-first openers with a midgame Stargate + Phoenix harass off this label (those fall through to Robo First). Hallucinated Phoenix from Sentries do NOT count.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - Phoenix into Robo",
    description:
      "Detected if Stargate is the FIRST tech building (before Robo AND Twilight), 1+ real (non-hallucinated) Phoenix is on the field by 7:00, AND a Robotics Facility is up by 8:00 -- a Stargate-first Phoenix opener that transitions into Robo tech. The Stargate-first ordering keeps Robo-first openers that ADD a midgame Stargate + real Phoenix off this label (those fall through to Robo First, since the OPENER was Robo). A Sentry's hallucinated Phoenix does NOT trigger this build.",
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
      "Detected if a Robotics Facility is built before 6:30 AND it is the FIRST tech building — Robo lands before any Twilight Council AND before any Stargate. The label describes the OPENER, not the entire composition: a Robo opener that transitions into Stargate tech later in the midgame (Skytoss tech-switch, end-game Tempests) still classifies as Robo First because the opening was Robo. Stargate-led openers are caught earlier by Phoenix into Robo / Phoenix Opener / Stargate Opener so they don't fall into this bucket.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - Standard Charge Macro",
    description:
      "Detected if Charge is researched by 9:00, the player has taken 3+ Nexuses, AND Twilight Council is the FIRST tech building — Twilight goes down before any Robotics Facility AND before any Stargate. The label describes the OPENER, not the entire composition: a Twilight-first Charge macro that later adds Robo (Observer / Immortal support) or transitions into Stargate tech in the midgame (Skytoss tech-switch, end-game Tempests, late Phoenix harass) still classifies as Standard Charge Macro because the opening was Twilight + Charge. Robo-first openers (Robo before Twilight) are caught by Robo First instead; Stargate-led openers are caught earlier by Stargate into Charge / Phoenix into Robo.",
  },
];
