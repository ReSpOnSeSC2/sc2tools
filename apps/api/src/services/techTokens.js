"use strict";

/**
 * CommonJS mirror of the TECH_TOKENS set in
 * ``apps/web/lib/build-rules.ts``. The web bundle owns the canonical
 * list (it's surfaced in the build editor's highlighter), but server
 * services — buildCompositions, future rule evaluators — need to read
 * the same set without pulling in the TypeScript module.
 *
 * Keep in sync with ``apps/web/lib/build-rules.ts:478-563``. The
 * buildCompositions test snapshots will go red if these drift.
 *
 * Exports both the original tokens (with ``Build`` / ``Morph`` /
 * ``Research`` prefixes — that's the shape the SPA event mapper emits)
 * AND a derived ``TECH_SC2_NAMES`` set with the prefix stripped, which
 * is the shape sc2reader uses in buildLog entries.
 */

const TECH_TOKENS = new Set([
  // Protoss tech buildings
  "BuildCyberneticsCore",
  "BuildTwilightCouncil",
  "BuildRoboticsFacility",
  "BuildRoboticsBay",
  "BuildStargate",
  "BuildFleetBeacon",
  "BuildTemplarArchives",
  "BuildTemplarArchive",
  "BuildDarkShrine",
  // Protoss key units
  "BuildStalker",
  "BuildSentry",
  "BuildAdept",
  "BuildPhoenix",
  "BuildOracle",
  "BuildVoidRay",
  "BuildTempest",
  "BuildCarrier",
  "BuildImmortal",
  "BuildColossus",
  "BuildDisruptor",
  "BuildHighTemplar",
  "BuildDarkTemplar",
  "BuildArchon",
  "BuildMothership",
  // Terran tech buildings
  "BuildFactory",
  "BuildStarport",
  "BuildArmory",
  "BuildFusionCore",
  "BuildEngineeringBay",
  "BuildGhostAcademy",
  "BuildOrbitalCommand",
  "BuildPlanetaryFortress",
  // Terran key units
  "BuildMarauder",
  "BuildReaper",
  "BuildHellion",
  "BuildHellbat",
  "BuildSiegeTank",
  "BuildCyclone",
  "BuildThor",
  "BuildBanshee",
  "BuildVikingFighter",
  "BuildLiberator",
  "BuildRaven",
  "BuildBattlecruiser",
  "BuildGhost",
  "BuildWidowMine",
  // Zerg tech buildings + morphs
  "BuildSpawningPool",
  "BuildRoachWarren",
  "BuildBanelingNest",
  "BuildHydraliskDen",
  "BuildSpire",
  "BuildInfestationPit",
  "BuildUltraliskCavern",
  "BuildNydusNetwork",
  "MorphLair",
  "MorphHive",
  "MorphGreaterSpire",
  "MorphLurkerDen",
  // Zerg key units
  "BuildRoach",
  "BuildHydralisk",
  "BuildMutalisk",
  "BuildCorruptor",
  "BuildInfestor",
  "BuildViper",
  "BuildSwarmHost",
  "BuildUltralisk",
  "MorphBaneling",
  "MorphLurker",
  "MorphRavager",
  "MorphBroodLord",
  "MorphOverseer",
]);

/**
 * sc2reader-shaped names for every entry above (``Build`` / ``Morph``
 * stripped). Used by buildLog scanners that match against the names
 * the agent actually emits.
 */
const TECH_SC2_NAMES = new Set();
for (const token of TECH_TOKENS) {
  if (token.startsWith("Build")) {
    TECH_SC2_NAMES.add(token.slice(5));
  } else if (token.startsWith("Morph")) {
    TECH_SC2_NAMES.add(token.slice(5));
  } else {
    TECH_SC2_NAMES.add(token);
  }
}

/**
 * @param {string | null | undefined} token
 * @returns {boolean}
 */
function isTechToken(token) {
  if (!token) return false;
  if (TECH_TOKENS.has(token)) return true;
  if (/^Research[A-Z]/.test(token)) return true;
  return false;
}

module.exports = { TECH_TOKENS, TECH_SC2_NAMES, isTechToken };
