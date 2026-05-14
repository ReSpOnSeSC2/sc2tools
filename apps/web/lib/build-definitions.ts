/**
 * Build & Strategy definitions catalog — the 101 detection rules used
 * by the analyzer to label opponent strategies and the player's own
 * builds. Surfaced on /definitions so users can interpret labels they
 * see on the dashboard, opponent profile, and builds page.
 *
 * Source of truth: the rules implemented in
 * `apps/api/src/services/strategyClassifier.js` (and its predecessor
 * `stream-overlay-backend/analyzer/strategy_rules.js`). When a rule
 * threshold changes there, mirror it here so the public catalog
 * stays accurate.
 *
 * Categorisation:
 *   - `race`       — owning race (Protoss/Terran/Zerg).
 *   - `matchup`    — narrower matchup tag, when the rule is matchup-specific.
 *   - `name`       — human title, displayed verbatim on /definitions.
 *   - `description`— the full text the analyzer attaches when the rule fires.
 */
import type { Race } from "@/lib/race";

export type StrategyMatchup =
  | "PvP"
  | "PvT"
  | "PvZ"
  | "TvP"
  | "TvT"
  | "TvZ"
  | "ZvP"
  | "ZvT"
  | "ZvZ"
  | null;

export interface BuildDefinition {
  /** Unique slug derived from the rule name (e.g. "pvp-1-gate-expand"). */
  id: string;
  /** Owning race. */
  race: Race;
  /** Optional narrower matchup. Null when the rule applies to all matchups for `race`. */
  matchup: StrategyMatchup;
  /** Display title — verbatim from the analyzer. */
  name: string;
  /** Detection rule prose — verbatim from the analyzer. */
  description: string;
}

const RAW_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  // ============================================================
  // Protoss — generic
  // ============================================================
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - 4 Gate Rush",
    description:
      "Detected if 4 Gateways exist before 6:00 and before the 2nd Nexus.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Blink All-In",
    description:
      "3 or 4 Gateways have been made along with Blink before 6:30 without a second Nexus.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Cannon Rush",
    description:
      "Detected if a Photon Cannon is built near your base (Proxy) before 4:30.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Chargelot All-in",
    description:
      "Detected if Charge is researched, 7+ Gates, and low gas count.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Chargelot/Archon Comp",
    description:
      "Mid/Late game composition fallback based on Archons and Chargelots.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - DT Rush",
    description: "Detected if a Dark Shrine is built before 7:30.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Glaive Adept Timing",
    description:
      "Detected if Twilight Council + Glaives researched + High Adept count by 6:30.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Proxy 4 Gate",
    description:
      "Detected if 3+ Gateways are built far from the main base before 4:30.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Proxy Robo Opener",
    description:
      "Detected if a Robo is built away from the opponents base before 6:30.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Proxy Stargate Opener",
    description:
      "Detected if a Stargate is built away from the opponents base before 6:30.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Robo Comp",
    description:
      "Mid/Late game composition fallback based on Colossi or Disruptors.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Robo Opener",
    description: "Detected if a Robotics Facility is built before 6:30.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Skytoss Transition",
    description:
      "Mid/Late game composition fallback based on multiple Stargates or Carriers.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Standard Expand",
    description: "Detected if the 2nd Nexus starts before 6:30.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Standard Macro (CIA)",
    description:
      "Detected if Protoss has 3 Bases and Charge/Immortal/Archon tech path.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Standard Play (Unclassified)",
    description: "Catch-all for unclassified Protoss games.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Stargate Opener",
    description: "Detected if a Stargate is built before 6:30.",
  },
  // ============================================================
  // PvP
  // ============================================================
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - 1 Gate Expand",
    description:
      "PvP standard 1-gate expand: exactly 1 Gateway finished before the natural Nexus (which goes down before 5:00) and the first warp-in is a Stalker / Adept / Zealot.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - 1 Gate Nexus into 4 Gate",
    description:
      "Detected if exactly 1 Gateway is started before the natural Nexus (which goes down before 5:00), 4+ Gateways exist by 6:00, the first warp-in is a Stalker / Adept / Zealot (NOT Sentry), no tech building (Stargate / Robotics Facility / Twilight Council / Templar Archive / Dark Shrine) is started before the 4th Gateway, and Warp Gate research begins by 5:30 -- the 1 Gate Nexus into 4 Gate Stalker timing.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - 2 Gate Expand",
    description:
      "PvP safer 2-gate expand: 2 (or more) Gateways are started before the natural Nexus (which goes down before 5:00) AND no tech building (Stargate, Robotics Facility, or Twilight Council) is started before the natural. A Stargate / Robo / Twilight before the natural means it is a tech-first opener, not a pure 2-gate expand. Trades a few seconds of economy for protection vs proxy 2-gate / early aggression.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - 4 Stalker Oracle into DT",
    description:
      "Detected if 3+ Stalkers by 6:30, 1+ Oracle by 7:30, and a Dark Shrine is built by 9:00 -- Stalker / Oracle harass transitioning into Dark Templar.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - AlphaStar (4 Adept/Oracle)",
    description:
      "Detected if a Stargate is built, 4+ Adepts have been produced by 6:00 AND 1+ Oracle is on the field by 6:30 -- the AlphaStar 4-Adept / Oracle pressure opener. Hallucinated Oracles from a Sentry do not count.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Blink Stalker Style",
    description:
      "Detected if Blink is researched by 9:00, the player has expanded (2+ Nexuses), and they have between 2 and 4 Gateways by 9:00 -- a macro Blink Stalker game.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Macro Transition (Unclassified)",
    description:
      "PvP catch-all: the game reached the macro phase but did not match a more specific PvP pattern.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Phoenix Style",
    description:
      "Detected if a Stargate is built and 3+ Phoenix have been produced by 8:30 -- an air-control / Phoenix-heavy PvP style. Hallucinated Phoenix from Sentries do not count.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Proxy 2 Gate",
    description:
      "Detected if a Gateway is built before 4:30 within 50 units of the OPPONENT's main base -- a proxied 2-Gate aggression.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Proxy Robo Opener",
    description:
      "Detected if a Robotics Facility is built before 6:30 within 50 units of the OPPONENT's main base -- a proxied Robo (Immortal / Warp Prism) opener.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Rail's Blink Stalker (Robo 1st)",
    description:
      "Detected if Robotics Facility goes down BEFORE Twilight Council and BOTH go down before the natural Nexus -- a Robo-first Blink Stalker style.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Standard Stargate Opener",
    description:
      "Detected if a Stargate is built before 6:30 in the player's own base (not proxied) -- the standard Stargate (Oracle / Phoenix) PvP opener.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Strange's 1 Gate Expand",
    description:
      "PvP 1-gate expand variant where exactly 1 Gateway is built before the natural Nexus and the first warp-in is a Sentry.",
  },
  // ============================================================
  // PvT
  // ============================================================
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
      "Detected if Blink is researched by 8:00, the player has taken 3+ Nexuses, exactly 2 Gateways exist by 8:00, AND a Robotics Facility is up by 8:00 -- a fast-3rd 2-Gate Blink style.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - 3 Gate Blink (Macro)",
    description:
      "Detected if Twilight Council goes BEFORE Robo and Stargate, Blink is researched by 9:00, AND fewer than 4 Gateways exist by 7:30 -- a macro 3-Gate Blink style.",
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
      "Detected if Twilight Council goes BEFORE Robo and Stargate, Blink is researched by 9:00, AND 4+ Gateways exist by 7:30 -- a 4-Gate Blink Stalker timing.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - 7 Gate Blink All-in",
    description:
      "Detected if Blink is researched by 9:00 AND 6+ Gateways exist by 9:00 -- a heavy multi-Gate Blink all-in.",
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
      "Detected if a Dark Shrine is built by 9:00 AND a Robotics Facility is up by 10:00 AND a Warp Prism is on the field by 10:00 -- a Dark Templar drop in PvT.",
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
      "Detected if a Stargate is built before any Twilight Council (the Stargate unit produced — Phoenix / Oracle / Void Ray — does NOT matter), a Twilight Council is built AFTER the Stargate, AND the FIRST upgrade researched out of the Twilight Council is Charge (i.e. Charge starts before Resonating Glaives and before Blink). Stargate harass into a 2-base Chargelot timing.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - Stargate into Glaives",
    description:
      "Detected if a Stargate is built before any Twilight Council (typically with Phoenix harass, but the Stargate unit does NOT matter), a Twilight Council is built AFTER the Stargate, AND the FIRST upgrade researched out of the Twilight Council is Resonating Glaives (Glaives starts before Blink and before Charge). The old-school Stargate-Phoenix into Glaive Adept midgame timing.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - Stargate into Blink",
    description:
      "Detected if a Stargate is built before any Twilight Council (the Stargate unit produced does NOT matter), a Twilight Council is built AFTER the Stargate, AND the FIRST upgrade researched out of the Twilight Council is Blink (i.e. Blink starts before Resonating Glaives and before Charge). Stargate harass into Blink Stalker macro/midgame.",
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
      "Detected if a Robotics Facility is built before 6:30 AND it is the FIRST tech building (before any Stargate or Twilight Council).",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - Standard Charge Macro",
    description:
      "Detected if Charge is researched by 9:00 AND the player has taken 3+ Nexuses -- standard 3-base Chargelot macro.",
  },
  // ============================================================
  // PvZ
  // ============================================================
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - 2 Stargate Phoenix",
    description:
      "Detected if EXACTLY 2 Stargates and 2+ Nexuses by 10:00, plus 4+ Phoenix produced by 10:00 (Phoenix without a Stargate are ignored as hallucinations). 3+ Stargates falls under PvZ - 3 Stargate Phoenix instead -- the two rules are mutually exclusive on Stargate count.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - 2 Stargate Void Ray",
    description:
      "Detected if 2+ Stargates and 2+ Nexuses by 10:00, plus 4+ Void Rays produced by 10:00 (Void Rays without a Stargate are ignored as hallucinations).",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - 3 Stargate Phoenix",
    description:
      "Detected if 3+ Stargates and 2+ Nexuses by 10:00, plus 4+ Phoenix produced by 10:00 (Phoenix without a Stargate are ignored as hallucinations).",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - 7 Gate Glaive/Immortal All-in",
    description:
      "Detected if a Robotics Facility is built, Glaives is researched by 8:30, 2+ Sentries and 1+ Immortal produced by 8:30, and 6+ Gateways exist by 9:00 -- a heavy Glaive Adept / Immortal all-in.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - AlphaStar Style (Oracle/Robo)",
    description:
      "Detected if a Stargate is built, 2+ Oracles plus a Robotics Facility plus a Forge are all in place by 8:30, with 3+ Nexuses by 8:30 -- the AlphaStar Oracle / Robo / fast 3rd composition.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Archon Drop",
    description:
      "Detected if Stargate goes down before Twilight Council, a Templar Archives is up by 9:00, and 2+ Archons have been produced by 9:00 -- Stargate opener transitioning into Archon drops. Requires Templar Archives (or Dark Shrine for DT-Archon morph).",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Blink Stalker All-in (2 Base)",
    description:
      "Detected if Blink is researched by 8:00, 5+ Gateways exist by 8:00, and the player has NOT built a Stargate or Dark Shrine by 8:00 -- a 2-base Blink all-in.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Carrier Rush",
    description:
      "Detected if a Stargate AND a Fleet Beacon are built and at least 1 Carrier has been produced by 10:00 -- skytoss into Carriers. Carriers without a Stargate + Fleet Beacon are treated as hallucinations.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - DT drop into Archon Drop",
    description:
      "Detected if Twilight Council goes down before Dark Shrine, a Dark Shrine AND a Robotics Facility are up by 9:00, 3+ Dark Templar are produced by 9:00, and a Warp Prism is on the field by 9:00.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Macro Transition (Unclassified)",
    description:
      "PvZ catch-all: the game reached the macro phase but did not match a more specific PvZ pattern.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Rail's Disruptor Drop",
    description:
      "Detected if a Robotics Facility AND a Robotics Bay are built and at least 1 Disruptor and 1 Warp Prism are produced by 8:00 -- an early Disruptor drop harass build.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Robo Opener",
    description:
      "Detected if a Robotics Facility is built before 7:00 AND it is the FIRST tech building (built before any Stargate or Twilight Council).",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Standard Blink Macro",
    description:
      "Detected if Stargate goes down before Twilight Council, Blink is researched by 10:00, and 3+ Nexuses are taken by 9:00 -- Stargate opener into 3-base Blink macro.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Standard charge Macro",
    description:
      "Detected if Stargate goes down before Twilight Council, Charge is researched by 9:00, and 3+ Nexuses are taken by 9:00 -- Stargate opener into 3-base Chargelot macro.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Stargate into Glaives",
    description:
      "Detected if a Stargate is built before 7:00 (and before any Twilight Council), the FIRST upgrade researched out of the Twilight Council is Resonating Glaives (Glaives starts BEFORE Blink and BEFORE Charge), and the player has 4-8 Gateways by 9:00 -- a Phoenix or Oracle into Glaive Adept timing. The Glaives-first signal is what separates this from Stargate into Blink, where Blink would be researched first instead.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Adept Glaives (No Robo)",
    description:
      "Detected if the Twilight Council is the FIRST tech building after the Cybernetics Core (no Stargate, Robotics Facility, or Dark Shrine is started before Twilight), the FIRST upgrade researched out of the Twilight Council is Resonating Glaives (Glaives starts BEFORE Blink and BEFORE Charge), 4-8 Gateways exist by 9:00, AND no Robotics Facility is built -- a pure Gateway Adept Glaive Timing without Robo support.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Adept Glaives (Robo)",
    description:
      "Detected if the Twilight Council is the FIRST tech building after the Cybernetics Core (no Stargate or Dark Shrine is started before Twilight), the FIRST upgrade researched out of the Twilight Council is Resonating Glaives (Glaives starts BEFORE Blink and BEFORE Charge), 4-8 Gateways exist by 9:00, AND a Robotics Facility is built -- the Robo variant of Adept Glaive Timing, using Observers for detection and Immortals for armor support.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Tempest Rush",
    description:
      "Detected if a Stargate AND a Fleet Beacon are built and at least 1 Tempest has been produced by 10:00 -- long-range Tempest harass / siege.",
  },
  // ============================================================
  // Terran
  // ============================================================
  {
    race: "Terran",
    matchup: null,
    name: "Terran - 1-1-1 One Base",
    description:
      "Detected if a Factory (before 6:30) and Starport (before 8:10) are both built BEFORE the second Command Center -- a 1-base 1-Rax / 1-Fact / 1-Port pressure build, not the standard expanding 1-1-1.",
  },
  {
    race: "Terran",
    matchup: "TvP",
    name: "TvP - 1-1-1 One Base",
    description:
      "Detected when the player is Terran in TvP and a Barracks, Factory, and Starport are ALL built before the second Command Center -- and none of the three is proxied (they all sit inside the main). The classic 1-base 1-1-1 all-in vs Protoss: Cloak Banshee / Marine-Tank / Marine-Medivac-Tank pressure off a single base with no expansion.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - 1-1-1 Standard",
    description:
      "Detected if Factory (before 6:30) and Starport (before 8:10) are built and they are after the second CC.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - 2 Gas 3 Reaper 2 Hellion",
    description: "Detected if 2 Gas, 3 Reapers, and 2 Hellions before 5:30.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - 2-3 Rax Reaper rush",
    description:
      "Detected if 3+ Barracks exist before 6:30 off a single Command Center, no Refineries, and 2+ Reapers have been produced before 6:30 -- early Reaper-heavy aggression.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - 3 Rax",
    description:
      "Detected if 3 Barracks are built after second CC but before any other tech buildings.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - 3-4 Rax Marine rush",
    description:
      "Detected if 3+ Barracks exist before 6:30 off a single Command Center with NO Refineries -- a gas-less, Marine-only mass-Rax all-in.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - BC Rush",
    description: "Detected if a Fusion Core is built before 6:30.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Banshee Rush",
    description:
      "Detected if a Banshee and Cloak or Hyper Flight Rotors exists before 7:30.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Bio Comp",
    description:
      "Mid/Late game composition fallback based on heavy Barracks production.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Cyclone Rush",
    description:
      "Detected if Factory with Tech Lab and Cyclones are built early (< 5:30).",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Fast 3 CC",
    description:
      "Detected if 3 Command Centers exist before 7:00 (Counting only construction, ignoring Orbitals).",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Ghost Rush",
    description:
      "Detected if Ghost Academy is built within first 6:30 of the game.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Hellbat All-in",
    description:
      "Detected if Armory is built early (< 5:00) with high Hellion/Hellbat count.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Mech Comp",
    description:
      "Mid/Late game composition fallback based on heavy Factory production.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Proxy 1-1-1",
    description:
      "Detected if Factory (before 6:30) and Starport (before 8:10) and are built away from their base.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Proxy Starport Hellion Drop",
    description:
      "Detected if a Factory and Starport are built away from the main base, the player has expanded (2nd Command Center started), 2+ Hellions are produced by 6:00, and the FIRST unit produced from the Starport is a Medivac -- an expanding proxy Starport build that uses a Medivac to ferry Hellions into the opponent's mineral line (Yoon-style Hellion drop). Differs from Proxy 1-1-1 by the 2nd CC and the Medivac-first opener.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Proxy Rax",
    description: "Detected if Barracks are built far from the main base before 4:30.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - SkyTerran",
    description:
      "Mid/Late game composition fallback based on heavy Starport production.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Standard Bio Tank",
    description:
      "Detected if 3 CCs, Engineering Bays, and Tanks/Medivacs are present.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Standard Play (Unclassified)",
    description: "Catch-all for unclassified Terran games.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Widow Mine Drop",
    description:
      "Detected if Medivac and multiple widow mines are built after second CC within the first 6:30.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Widow Mine Drop into Thor Rush",
    description:
      "Detected if a Medivac and 2+ Widow Mines are built AFTER the second Command Center (within ~6:30), and a Thor has been produced before ~8:10 -- a Mine drop transitioning into Thor pressure.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Widow Upgraded Mine Cheese",
    description:
      "Detected if a Medivac and 2+ Widow Mines are built BEFORE the second Command Center -- a 1-base Widow Mine drop cheese.",
  },
  // ============================================================
  // Zerg
  // ============================================================
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 1 Base Roach Rush",
    description:
      "Detected if a Roach Warren is built off 1 base very early (< 3:40).",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 12 Pool",
    description:
      "Detected if Spawning Pool starts < 50s and NO new drones were built (Strict 12 Supply).",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 13/12 Baneling Bust",
    description:
      "Early pool and early gas (<70s) leading into Baneling Nest before 3:20.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 13/12 Speedling Aggression",
    description: "Early pool and early gas (<70s) for aggressive speedlings.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 17 Hatch 18 Gas 17 Pool",
    description:
      "Standard modern Zerg macro opener (Hatch < 85s, Gas < 95s, Pool < 105s).",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 2 Base Muta Rush",
    description: "Detected if a Spire is started before 7:00 with low drone count.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 2 Base Nydus",
    description: "Detected if a Nydus Network is built before 7:00.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 2 Base Roach/Ravager All-in",
    description:
      "Detected if Roach Warren exists, Lair exists, high Roaches/Ravagers count, low drone count (< 40) off 2 bases.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 3 Base Macro (Hatch First)",
    description:
      "Standard safe Zerg macro reaching 3 bases by 6:30 off a Hatch First.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 3 Base Macro (Pool First)",
    description:
      "Standard safe Zerg macro reaching 3 bases by 6:30 off a Pool First.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 3 Hatch Before Pool",
    description: "Detected if a 3rd Hatchery is started before the Spawning Pool.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 3 Hatch Ling Flood",
    description: "Detected 3 bases but >20 lings and <30 drones by 5:00.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - Early Pool (14/14 or 15 Pool)",
    description:
      "Detected if Spawning Pool starts < 1:10 but drones were built.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - Hydra Comp",
    description: "Mid/Late game composition fallback featuring Hydralisks.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - Muta/Ling/Bane Comp",
    description:
      "Mid/Late game composition fallback based on Mutalisks and Banelings.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - Pool First Opener",
    description:
      "Generic Pool first opener that transitions into standard macro.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - Proxy Hatch",
    description:
      "Detected if a hatchery being built on the opponents side of the map within the first 4:30.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - Roach/Ravager Comp",
    description:
      "Mid/Late game composition fallback heavily focused on Roaches and Ravagers.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - Standard Play (Unclassified)",
    description: "Catch-all for unclassified Zerg games.",
  },
];

function slugifyDef(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export const BUILD_DEFINITIONS: ReadonlyArray<BuildDefinition> =
  RAW_DEFINITIONS.map((d) => ({
    ...d,
    id: slugifyDef(d.name),
  }));

export const DEFINITIONS_TOTAL = BUILD_DEFINITIONS.length;

export function filterDefinitions(
  defs: ReadonlyArray<BuildDefinition>,
  query: string,
  race: Race | "All",
  matchup: StrategyMatchup | "All",
): BuildDefinition[] {
  const q = query.trim().toLowerCase();
  return defs.filter((d) => {
    if (race !== "All" && d.race !== race) return false;
    if (matchup !== "All" && matchup !== null) {
      // `matchup: null` on a definition means "applies to every matchup
      // for this race" (see the type comment above), so a generic rule
      // like "Protoss - 4 Gate Rush" must surface under PvP, PvT, and
      // PvZ. Without this branch every Terran/Zerg entry (all `null`)
      // would vanish whenever the user picked TvT/TvZ/.../ZvZ.
      if (d.matchup !== null && d.matchup !== matchup) return false;
    }
    if (!q) return true;
    return (
      d.name.toLowerCase().includes(q) ||
      d.description.toLowerCase().includes(q)
    );
  });
}
