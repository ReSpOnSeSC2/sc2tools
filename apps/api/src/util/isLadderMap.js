"use strict";

/**
 * Ladder-map membership test + the canonical all-seasons ladder map set.
 *
 * The live ladder pool (LadderMapPoolService) only knows the CURRENT
 * season's rotation. Classifying a game purely against that mislabels
 * any game played on a ladder map from a PAST season (since rotated
 * out) as "custom". To fix that, ``ALL_LADDER_MAPS`` below is the full
 * union of every LotV 1v1 + team ladder map across all seasons, sourced
 * from Liquipedia's "Ladder Map Timeline"
 * (Maps/Ladder_Maps/Legacy_of_the_Void). ``buildClassifierSet`` unions
 * it with whatever the live pool currently returns, so brand-new maps
 * added after this list was captured are still covered the moment the
 * live fetch sees them — and historical maps are covered even offline.
 *
 * A replay's stored map name doesn't always match a pool name
 * byte-for-byte: SC2 ships names with a trailing " LE" (Ladder
 * Edition) / " TE" (Team Edition) tag, localized punctuation, and
 * stray whitespace. Normalising both sides to a lowercase alphanumeric
 * key (dropping the LE/TE tags) lets the comparison survive those
 * variations without a brittle exact-string match.
 */

// Bump whenever the classification logic or ALL_LADDER_MAPS changes in
// a way that should re-stamp existing games. The startup backfill job
// records this per game (``isLadderMapV``) and reclassifies any game
// not at the current version on the next deploy, then self-skips. v1
// was the current-pool-only classifier; v2 is the all-seasons set.
const LADDER_CLASSIFY_VERSION = 2;

// All LotV ladder maps (1v1 + 2v2/3v3/4v4) across every season, from
// the Liquipedia Ladder Map Timeline. Over-inclusive by design: an
// extra name only costs a false ladder-MAP membership stamp, whereas a
// missing name loses historical map coverage. This utility never decides
// whether the replay itself was ranked; ``isLadderGame`` owns that.
const ALL_LADDER_MAPS = Object.freeze([
  "10000 Feet LE",
  "16-Bit LE",
  "2000 Atmospheres LE",
  "Abandoned Camp",
  "Abandoned Parish",
  "Abiogenesis LE",
  "Abyssal Reef LE",
  "Acid Plant LE",
  "Acolyte LE",
  "Acropolis LE",
  "Alaeni Enclave CE",
  "Alcyone LE",
  "Altitude LE",
  "Amphion LE",
  "Amygdala LE",
  "Ancient Cistern LE",
  "Apotheosis LE",
  "Arctic Dream LE",
  "Arctic Flowers LE",
  "Arctic Gates",
  "Arkadia",
  "Ascension to Aiur LE",
  "Ashen Cradle",
  "Asper Mountain",
  "Augustine Fall LE",
  "Automaton LE",
  "Avalon Labs",
  "Babylon LE",
  "Backcountry",
  "Backwater LE",
  "Bastion of the Conclave",
  "Battle on the Boardwalk LE",
  "Beckett Industries LE",
  "Bel'Shir Vestige",
  "Berlingrad LE",
  "Black Site 2E",
  "Blackburn LE",
  "Blackpink LE",
  "Blood Boil LE",
  "Blueshift LE",
  "Bone Temple LE",
  "Breakwater LE",
  "Bridgehead",
  "Buried Caverns",
  "Cactus Valley",
  "Canyon of Tribulation",
  "Catalesque CE",
  "Catallena",
  "Catalyst LE",
  "Celestial Enclave LE",
  "Central Protocol",
  "Cerulean Fall LE",
  "Coda",
  "Concord LE",
  "Cosmic Sapphire LE",
  "Crimson Court LE",
  "Crimson Research Lab LE",
  "Cryptic Fortress",
  "Curious Minds LE",
  "Cyber Forest LE",
  "Darkness Sanctuary LE",
  "Dasan Station LE",
  "Dash and Terminal",
  "Data-C LE",
  "Daybreak",
  "Deathaura LE",
  "Defender's Landing LE",
  "Desolator",
  "Disco Bloodbath LE",
  "Distant Plane",
  "Divergence CE",
  "Doraelus Hills",
  "Dragon Scales LE",
  "Dreamcatcher LE",
  "Dusk Towers",
  "Dusty Gorge",
  "Dynasty LE",
  "Dystopian Complex",
  "Eastwatch LE",
  "Echo",
  "Efflorescence LE",
  "El Dorado LE",
  "Emerald City CE",
  "Enigma CE",
  "Ephemeron LE",
  "Equilibrium LE",
  "Eternal Empire LE",
  "Ever Dream LE",
  "Fields of Death CE",
  "Fields of Shazir",
  "Flashback CE",
  "Flooded City",
  "Floodplain",
  "Forgotten Sanctuary",
  "Fortitude LE",
  "Fractional Distillation Plant",
  "Fracture LE",
  "Frost",
  "Frostline LE",
  "Frozen Temple",
  "Galactic Process LE",
  "Garden of Shadows",
  "Gemgarden LE",
  "Ghost River LE",
  "Glittering Ashes LE",
  "Golden Wall LE",
  "Goldenaura LE",
  "Gresvan LE",
  "Habitation Station",
  "Hard Lead LE",
  "Hardwire LE",
  "Heavy Artillery LE",
  "Hecate LE",
  "Hidden Caves",
  "Hills of Peshkov",
  "Honorgrounds LE",
  "Ice and Chrome LE",
  "Ice Cliffs",
  "Incorporeal LE",
  "Inferno Pools",
  "Infestation",
  "Inside and Out LE",
  "Interloper LE",
  "Invader LE",
  "Iron Fortress",
  "Jagannatha LE",
  "Jungle Depths CE",
  "Kairos Junction LE",
  "Kimeran Refuge",
  "King's Cove LE",
  "Korhal Carnage Knockout",
  "Last Fantasy LE",
  "Last Impact",
  "Last Remnant",
  "Lerilak Crest",
  "Lexiphanicism CE",
  "Ley Lines",
  "Lightshade LE",
  "Lost and Found LE",
  "Lost July",
  "Magannatha LE",
  "Magma Mines",
  "Mech Depot LE",
  "Megastructure",
  "Mementos LE",
  "Misty Swamp",
  "Moebius Facility XX-1",
  "Molten Temple",
  "Moondance LE",
  "Moonlight Madness",
  "Morheimen",
  "Mothership LE",
  "Mountain Pass CE",
  "Multiprocessor CE",
  "Nekodrec LE",
  "NeoHumanity LE",
  "Neon Violet Square LE",
  "Nephor I",
  "New Bed of Chaos LE",
  "New Gettysburg LE",
  "New Repugnancy LE",
  "New Richmond",
  "New Williamsberg",
  "Newkirk Precinct",
  "Nightscape CE",
  "Nightshade LE",
  "Oceanborn LE",
  "Odyssey LE",
  "Old Estate",
  "Old Republic LE",
  "Omicron",
  "Orbital Depot",
  "Orbital Shipyard",
  "Overgrown Facility",
  "Overgrowth",
  "Oxide LE",
  "Paladino Terminal LE",
  "Para Site LE",
  "Persephone LE",
  "Pillars of Gold LE",
  "Polka LE",
  "Port Aleksander LE",
  "Post-Youth LE",
  "Pride of Altaris LE",
  "Primeval Wilds",
  "Prion Terraces",
  "Proxima Station LE",
  "Purity and Industry LE",
  "Pylon LE",
  "Radhuset Station LE",
  "Realities Simulation LE",
  "Reclamation LE",
  "Redshift LE",
  "Redstorm",
  "Refinery XJ-17",
  "Research Site JD-2",
  "Rhoskallian LE",
  "Romanticide LE",
  "Rooftop Terrace",
  "Rosebud LE",
  "Royal Blood LE",
  "Ruby Rock LE",
  "Ruins of Endion",
  "Ruins of Seras",
  "Rust Bucket LE",
  "Sacred Grounds",
  "Sandstorm CE",
  "Scoria Reactor",
  "Seeds of Aiur",
  "Seething Jungle",
  "Sentinel CE",
  "Sequencer LE",
  "Shadowed Jungle",
  "Shipwrecked LE",
  "Shrines of Lizul",
  "Simulacrum LE",
  "Site Delta LE",
  "Slaying Field",
  "Slowdive",
  "Sludge City",
  "Snowbound Colony",
  "Snowy Mesa",
  "Solaris LE",
  "Stargazers LE",
  "Stasis LE",
  "Stranded Isles",
  "Submarine LE",
  "Sunset Valley LE",
  "Taito Citadel LE",
  "Terraform",
  "The King Sejong Station",
  "Thunderbird LE",
  "Tokamak LE",
  "Torches LE",
  "Tourmaline LE",
  "Traitor's Exile",
  "Triton LE",
  "Troizinia LE",
  "Tropic Shores",
  "Tropical Sacrifice LE",
  "Tunguska",
  "Tuonela LE",
  "Turbo Cruise '84 LE",
  "Ujari",
  "Ulrena",
  "Ultralove",
  "Ulzaan",
  "Undercurrent LE",
  "Vaani Research Station",
  "Void Zone",
  "Voracity",
  "Waterfall LE",
  "Whirlwind",
  "Whispers of Gold LE",
  "White Chamber",
  "White Rabbit LE",
  "Whitewater Line LE",
  "Winter Madness LE",
  "Winter's Gate LE",
  "Wolfe Industries Compound",
  "World of Sleepers LE",
  "Year Zero LE",
  "Yellowjacket",
  "Zen LE",]);

/**
 * Reduce a map name to a comparison key: lowercase, drop the LE/TE
 * edition tags, strip everything that isn't a letter or digit.
 *
 * @param {unknown} name
 * @returns {string}
 */
function normalizeMapName(name) {
  return String(name == null ? "" : name)
    .toLowerCase()
    .replace(/\b(?:le|te)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Build a Set of normalized keys from a list of canonical map names.
 *
 * @param {string[]} pool
 * @returns {Set<string>}
 */
function buildLadderMapSet(pool) {
  const set = new Set();
  for (const m of Array.isArray(pool) ? pool : []) {
    const key = normalizeMapName(m);
    if (key) set.add(key);
  }
  return set;
}

/**
 * The set the isLadderMap classifier should use: the all-seasons
 * historical list unioned with whatever the live pool currently
 * returns (pass ``[...maps, ...teamMaps]``). Always non-empty thanks to
 * the baked-in historical list, so classification stays correct even
 * when Liquipedia is unreachable.
 *
 * @param {string[]} [livePoolMaps]
 * @returns {Set<string>}
 */
function buildClassifierSet(livePoolMaps) {
  return buildLadderMapSet([
    ...ALL_LADDER_MAPS,
    ...(Array.isArray(livePoolMaps) ? livePoolMaps : []),
  ]);
}

/**
 * @param {unknown} mapName
 * @param {Set<string>} ladderSet
 * @returns {boolean}
 */
function isLadderMap(mapName, ladderSet) {
  if (!(ladderSet instanceof Set) || ladderSet.size === 0) return false;
  const key = normalizeMapName(mapName);
  return key.length > 0 && ladderSet.has(key);
}

module.exports = {
  ALL_LADDER_MAPS,
  LADDER_CLASSIFY_VERSION,
  normalizeMapName,
  buildLadderMapSet,
  buildClassifierSet,
  isLadderMap,
};
