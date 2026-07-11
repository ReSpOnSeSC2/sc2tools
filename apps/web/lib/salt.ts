/**
 * SALT build-order encoder — exports SC2 Tools builds as strings the
 * SALT in-game practice map (Battle.net Arcade) can import, matching
 * the encoding lotv.spawningtool.com emits via "Get SALT Encoding".
 *
 * Format (verified against the reference decoder in
 * Veritasimo/sc2-scrapbook `SALT.cs` and by decoding live
 * spawningtool.com encodings, e.g. builds 93714 / 179397 / 184604):
 *
 *   <version><title>|<author>|<description>|~<step><step>...
 *
 * - Every numeric field is a single printable-ASCII character:
 *   `chr(value + 32)` — an index into the charset that starts at
 *   space (values 0..94, chars " " through "~").
 * - <version> is one character; spawningtool emits a literal "$"
 *   (decodes to 4), which is what the current SALT map accepts.
 * - The metadata section must contain exactly three "|"-terminated
 *   fields before the "~" (the reference decoder splits on "|" and
 *   asserts 4 parts), so "|" and "~" may not appear inside them.
 * - Each step is exactly 5 chars: supply, minutes, seconds, type,
 *   item id. Supply is biased by the map's minimum supply of 5:
 *   encoded = supply - 5 + 1, with 0 meaning "blank". Encodable
 *   ranges are therefore supply 5..98 and time 0:00..94:59.
 * - Type codes: 0=structure, 1=unit, 2=morph, 3=upgrade. Morphs are
 *   what the SALT map treats as transformations (Orbital Command,
 *   Warp Gate, Lair, Baneling, Archon, ...), even though this repo
 *   files most of them under buildings/units — the tables below win
 *   over the caller-supplied kind for exactly that reason.
 * - Item ids come from SALT's fixed per-type tables (mirrored below).
 *   Entities the SALT map predates or never knew (Shield Battery,
 *   Shadow Stride, Flux Vanes, Mag-Field Accelerator, ...) have no
 *   id; those steps are skipped rather than mis-encoded.
 */

export type SaltKind = "structure" | "unit" | "upgrade" | "morph";

export interface SaltStep {
  supply: number;
  timeSec: number;
  kind: SaltKind;
  name: string;
}

export interface SaltItem {
  kind: SaltKind;
  id: number;
}

export interface SaltEncodeOptions {
  author?: string;
  description?: string;
}

export interface SaltEncodeResult {
  salt: string;
  /** Raw `name`s of steps that had no SALT table entry, in order. */
  skipped: string[];
}

/** First character of every spawningtool-compatible SALT string. */
const VERSION_CHAR = "$";
/** Encoded values map to chars via `chr(value + CHAR_BASE)`. */
const CHAR_BASE = 32;
/** Largest encodable field value ("~" = 126 = 32 + 94). */
const MAX_VALUE = 94;
/** The SALT map's minimum supply; encoded supply is biased by it. */
const MIN_SUPPLY = 5;
const MAX_SUPPLY = MIN_SUPPLY + MAX_VALUE - 1; // 98
const MAX_TIME_SEC = MAX_VALUE * 60 + 59; // 94:59

const TYPE_CODES: Record<SaltKind, number> = {
  structure: 0,
  unit: 1,
  morph: 2,
  upgrade: 3,
};

/**
 * SALT item tables: [kind, id, aliases]. The first alias is the SALT
 * map's own display name (normalized); the rest cover this repo's
 * replay-event / sc2reader spellings so `saltItemFor` tolerates
 * "SpawningPool", "Spawning Pool", and "spawningpool" alike.
 * Aliases must be globally unique across all four tables.
 */
const TABLE: ReadonlyArray<readonly [SaltKind, number, readonly string[]]> = [
  // ---- Structures (type 0) — Terran ----
  ["structure", 0, ["armory"]],
  ["structure", 1, ["barracks", "rax"]],
  ["structure", 2, ["bunker"]],
  ["structure", 3, ["commandcenter"]],
  ["structure", 4, ["engineeringbay", "engbay", "ebay"]],
  ["structure", 5, ["factory"]],
  ["structure", 6, ["fusioncore"]],
  ["structure", 7, ["ghostacademy"]],
  ["structure", 8, ["missileturret", "turret"]],
  ["structure", 9, ["reactorbarracks", "barracksreactor", "reactor"]],
  ["structure", 10, ["reactorfactory", "factoryreactor"]],
  ["structure", 11, ["reactorstarport", "starportreactor"]],
  ["structure", 12, ["refinery"]],
  ["structure", 13, ["sensortower"]],
  ["structure", 14, ["starport"]],
  ["structure", 15, ["supplydepot", "depot"]],
  ["structure", 16, ["techlabbarracks", "barrackstechlab", "techlab"]],
  ["structure", 17, ["techlabfactory", "factorytechlab"]],
  ["structure", 18, ["techlabstarport", "starporttechlab"]],
  // ---- Structures — Protoss ----
  ["structure", 19, ["assimilator"]],
  ["structure", 20, ["cyberneticscore", "cybercore"]],
  ["structure", 21, ["darkshrine"]],
  ["structure", 22, ["fleetbeacon"]],
  ["structure", 23, ["forge"]],
  ["structure", 24, ["gateway"]],
  ["structure", 25, ["nexus"]],
  // SALT.cs spells it "Photon Canon"; accept the correct spelling too.
  ["structure", 26, ["photoncannon", "photoncanon", "cannon"]],
  ["structure", 27, ["pylon"]],
  ["structure", 28, ["roboticsbay", "robobay"]],
  ["structure", 29, ["roboticsfacility", "robo"]],
  ["structure", 30, ["stargate"]],
  ["structure", 31, ["templararchives", "templararchive"]],
  ["structure", 32, ["twilightcouncil", "twilight"]],
  // ---- Structures — Zerg ----
  ["structure", 33, ["banelingnest"]],
  ["structure", 34, ["evolutionchamber", "evochamber"]],
  ["structure", 35, ["extractor"]],
  ["structure", 36, ["hatchery", "hatch"]],
  ["structure", 37, ["hydraliskden"]],
  ["structure", 38, ["infestationpit"]],
  ["structure", 39, ["nydusnetwork", "nydus"]],
  ["structure", 40, ["roachwarren"]],
  ["structure", 41, ["spawningpool", "pool"]],
  ["structure", 42, ["spinecrawler", "spine", "spinecrawleruprooted"]],
  ["structure", 43, ["spire"]],
  ["structure", 44, ["sporecrawler", "spore", "sporecrawleruprooted"]],
  ["structure", 45, ["ultraliskcavern"]],
  ["structure", 46, ["creeptumor", "creeptumorqueen", "creeptumorburrowed"]],

  // ---- Units (type 1) — Terran ----
  ["unit", 0, ["banshee"]],
  ["unit", 1, ["battlecruiser", "bc"]],
  ["unit", 2, ["ghost"]],
  ["unit", 3, ["hellion"]],
  ["unit", 4, ["marauder"]],
  ["unit", 5, ["marine"]],
  ["unit", 6, ["medivac"]],
  ["unit", 7, ["raven"]],
  ["unit", 8, ["reaper"]],
  ["unit", 9, ["scv"]],
  ["unit", 10, ["siegetank", "siegetanksieged", "tank"]],
  ["unit", 11, ["thor"]],
  ["unit", 12, ["viking", "vikingfighter", "vikingassault"]],
  // "Battle Hellion" is the HotS-era SALT name for the Hellbat;
  // "HellionTank" is the game's internal unit type for it.
  ["unit", 40, ["battlehellion", "hellbat", "helliontank"]],
  ["unit", 41, ["warhound"]],
  ["unit", 42, ["widowmine", "widowmineburrowed"]],
  ["unit", 48, ["cyclone"]],
  ["unit", 49, ["liberator", "liberatorag"]],
  // ---- Units — Protoss ----
  ["unit", 14, ["carrier"]],
  ["unit", 15, ["colossus"]],
  ["unit", 16, ["darktemplar", "dt"]],
  ["unit", 17, ["hightemplar", "ht"]],
  ["unit", 18, ["immortal"]],
  ["unit", 19, ["mothership"]],
  ["unit", 20, ["observer"]],
  ["unit", 21, ["phoenix"]],
  ["unit", 22, ["probe"]],
  ["unit", 23, ["sentry"]],
  ["unit", 24, ["stalker"]],
  ["unit", 25, ["voidray"]],
  ["unit", 26, ["zealot", "chargelot"]],
  ["unit", 39, ["warpprism"]],
  ["unit", 43, ["mothershipcore"]],
  ["unit", 44, ["oracle"]],
  ["unit", 45, ["tempest"]],
  ["unit", 50, ["disruptor"]],
  // The SALT table's own name is plural ("Adepts").
  ["unit", 51, ["adepts", "adept"]],
  // ---- Units — Zerg ----
  ["unit", 27, ["corruptor"]],
  ["unit", 28, ["drone"]],
  ["unit", 29, ["hydralisk", "hydra"]],
  ["unit", 30, ["mutalisk", "muta"]],
  ["unit", 31, ["overlord", "overlordtransport"]],
  ["unit", 32, ["queen"]],
  ["unit", 33, ["roach"]],
  ["unit", 34, ["ultralisk", "ultra"]],
  ["unit", 35, ["zergling", "ling", "speedling"]],
  ["unit", 38, ["infestor"]],
  ["unit", 46, ["swarmhost", "swarmhostmp"]],
  ["unit", 47, ["viper"]],

  // ---- Morphs (type 2) ----
  ["morph", 0, ["orbitalcommand", "orbital"]],
  ["morph", 1, ["planetaryfortress", "planetary"]],
  ["morph", 2, ["warpgate"]],
  ["morph", 3, ["lair"]],
  ["morph", 4, ["hive"]],
  ["morph", 5, ["greaterspire"]],
  ["morph", 6, ["broodlord", "broodlordcocoon"]],
  ["morph", 7, ["baneling", "bane", "banelingcocoon"]],
  ["morph", 8, ["overseer", "overlordcocoon", "overseersiegemode"]],
  ["morph", 9, ["ravager", "ravagercocoon"]],
  ["morph", 10, ["lurker", "lurkermp", "lurkermpegg", "lurkermpburrowed", "lurkeregg"]],
  ["morph", 12, ["lurkerden", "lurkerdenmp"]],
  ["morph", 13, ["archon"]],

  // ---- Upgrades (type 3) — Terran ----
  ["upgrade", 0, ["terranbuildingarmor", "neosteelarmor", "buildingarmor"]],
  ["upgrade", 1, ["terraninfantryarmor", "terraninfantryarmors"]],
  ["upgrade", 2, ["terraninfantryweapons"]],
  ["upgrade", 3, ["terranshipplating", "terranshiparmor", "terranshiparmors"]],
  ["upgrade", 4, ["terranshipweapons"]],
  // LotV merged vehicle+ship plating into one upgrade; SALT predates
  // that, so the merged names fold onto Vehicle Plating (5).
  [
    "upgrade",
    5,
    [
      "terranvehicleplating",
      "terranvehiclearmor",
      "terranvehiclearmors",
      "terranvehicleandshiparmor",
      "terranvehicleandshiparmors",
      "terranvehicleandshipplating",
    ],
  ],
  ["upgrade", 6, ["terranvehicleweapons"]],
  ["upgrade", 7, ["250mmstrikecannons"]],
  ["upgrade", 8, ["bansheecloak", "bansheecloakingfield", "cloakingfield"]],
  ["upgrade", 9, ["ghostcloak", "personalcloaking", "personalcloak"]],
  ["upgrade", 10, ["infernalpreigniter", "highcapacitybarrels", "preigniter"]],
  ["upgrade", 11, ["stimpack", "stim"]],
  ["upgrade", 12, ["seekermissile", "seekermissiles", "huntersseekermissile"]],
  ["upgrade", 13, ["siegetech"]],
  ["upgrade", 14, ["neosteelframe"]],
  ["upgrade", 15, ["concussiveshells", "punishergrenades", "concussive"]],
  ["upgrade", 16, ["combatshield", "combatshields", "shieldwall"]],
  ["upgrade", 17, ["reaperspeed", "nitropacks"]],
  ["upgrade", 46, ["moebiusreactor"]],
  ["upgrade", 51, ["behemothreactor"]],
  ["upgrade", 52, ["weaponrefit", "battlecruiserenablespecializations"]],
  ["upgrade", 53, ["hisecautotracking"]],
  ["upgrade", 54, ["caduceusreactor", "medivaccaduceusreactor"]],
  ["upgrade", 55, ["corvidreactor", "ravencorvidreactor"]],
  ["upgrade", 56, ["durablematerials"]],
  // "Transformation Servos" is the HotS name for LotV's Smart Servos.
  ["upgrade", 57, ["transformationservos", "smartservos"]],
  ["upgrade", 66, ["drillingclaws", "drillclaws"]],
  // ---- Upgrades — Protoss ----
  ["upgrade", 18, ["protossgroundarmor", "protossgroundarmors"]],
  ["upgrade", 19, ["protossgroundweapons"]],
  ["upgrade", 20, ["protossairarmor", "protossairarmors"]],
  ["upgrade", 21, ["protossairweapons"]],
  ["upgrade", 22, ["protossshields"]],
  ["upgrade", 23, ["hallucination"]],
  ["upgrade", 24, ["psistorm", "psionicstorm", "psistormtech"]],
  ["upgrade", 25, ["blink", "blinktech"]],
  ["upgrade", 26, ["warpgatetech", "warpgateresearch", "researchwarpgate"]],
  ["upgrade", 27, ["charge", "zealotcharge"]],
  ["upgrade", 47, ["extendedthermallance", "thermallance"]],
  ["upgrade", 58, ["gravitoncatapult", "carrierlaunchspeedupgrade"]],
  ["upgrade", 59, ["graviticboosters", "graviticbooster", "observergraviticbooster"]],
  ["upgrade", 60, ["graviticdrive"]],
  ["upgrade", 61, ["bosoniccore"]],
  ["upgrade", 62, ["gravitysling"]],
  ["upgrade", 67, ["anionpulsecrystals", "phoenixrangeupgrade"]],
  ["upgrade", 73, ["resonatingglaives", "adeptpiercingattack", "glaives"]],
  // ---- Upgrades — Zerg ----
  ["upgrade", 28, ["zerggroundcarapace", "zerggroundarmor", "zerggroundarmors"]],
  ["upgrade", 29, ["zergmeleeweapons", "zergmeleeattacks"]],
  ["upgrade", 30, ["zergflyercarapace", "zergflyerarmor", "zergflyerarmors"]],
  ["upgrade", 31, ["zergflyerweapons", "zergflyerattacks"]],
  ["upgrade", 32, ["zergmissileweapons", "zergmissileattacks"]],
  ["upgrade", 33, ["groovedspines", "evolvegroovedspines"]],
  ["upgrade", 34, ["pneumatizedcarapace", "overlordspeed"]],
  ["upgrade", 35, ["ventralsacs"]],
  ["upgrade", 36, ["glialreconstitution", "glialregeneration", "roachspeed"]],
  ["upgrade", 38, ["tunnelingclaws"]],
  ["upgrade", 40, ["chitinousplating"]],
  ["upgrade", 41, ["adrenalglands", "zerglingadrenalglands", "zerglingattackspeed"]],
  [
    "upgrade",
    42,
    ["metabolicboost", "zerglingmetabolicboost", "zerglingmovementspeed", "lingspeed"],
  ],
  ["upgrade", 44, ["burrow"]],
  ["upgrade", 45, ["centrifugalhooks", "centrificalhooks"]],
  ["upgrade", 49, ["neuralparasite"]],
  ["upgrade", 50, ["pathogengland", "pathogenglands", "infestorenergyupgrade"]],
  ["upgrade", 64, ["enduringlocusts", "evolveenduringlocusts"]],
  ["upgrade", 65, ["muscularaugments", "evolvemuscularaugments", "hydraliskspeed"]],
  ["upgrade", 68, ["flyinglocusts"]],
  ["upgrade", 69, ["seismicspines", "lurkerrange"]],
  ["upgrade", 71, ["targetingoptics"]],
  ["upgrade", 72, ["advancedballistics", "liberatoragrangeupgrade"]],
];

const LOOKUP: ReadonlyMap<string, SaltItem> = (() => {
  const map = new Map<string, SaltItem>();
  for (const [kind, id, aliases] of TABLE) {
    for (const alias of aliases) {
      if (!map.has(alias)) map.set(alias, { kind, id });
    }
  }
  return map;
})();

/** Lowercase and strip everything but letters/digits ("Spawning Pool" → "spawningpool"). */
function normalizeSaltName(input: string): string {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function resolveSaltItem(name: string): SaltItem | null {
  const normalized = normalizeSaltName(name);
  if (!normalized) return null;
  const candidates = [normalized];
  // Tiered upgrades carry a level suffix the SALT tables don't have.
  const noLevel = normalized.replace(/level[0-9]+$/, "");
  if (noLevel !== normalized) candidates.push(noLevel);
  const noDigits = noLevel.replace(/(?<=[a-z])[0-9]+$/, "");
  if (noDigits !== noLevel) candidates.push(noDigits);
  for (const candidate of candidates) {
    const hit = LOOKUP.get(candidate);
    if (hit) return hit;
  }
  return null;
}

/**
 * Resolve a free-form entity name to its SALT table entry, tolerant
 * of this repo's event spellings ("SpawningPool", "Spawning Pool",
 * "spawning_pool", "ProtossGroundWeaponsLevel2", ...). Returns null
 * when the SALT map has no id for the entity.
 */
export function saltItemFor(name: string): { kind: string; id: number } | null {
  const hit = resolveSaltItem(name);
  return hit ? { kind: hit.kind, id: hit.id } : null;
}

/** Encode a raw field value (already in 0..94) as its SALT character. */
function encChar(value: number): string {
  const v = Math.min(Math.max(Math.round(value), 0), MAX_VALUE);
  return String.fromCharCode(CHAR_BASE + v);
}

function encodeSupply(supply: number): string {
  if (!Number.isFinite(supply)) return encChar(0); // blank
  const clamped = Math.min(Math.max(Math.round(supply), MIN_SUPPLY), MAX_SUPPLY);
  return encChar(clamped - MIN_SUPPLY + 1);
}

function encodeTime(timeSec: number): string {
  const total = Number.isFinite(timeSec)
    ? Math.min(Math.max(Math.round(timeSec), 0), MAX_TIME_SEC)
    : 0;
  return encChar(Math.floor(total / 60)) + encChar(total % 60);
}

/**
 * Metadata fields may only contain printable ASCII and must not
 * contain "|" (field separator) or "~" (section terminator).
 */
function sanitizeMeta(text: string): string {
  let out = "";
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0);
    if (code < CHAR_BASE || code > CHAR_BASE + MAX_VALUE) continue;
    out += ch === "|" || ch === "~" ? "-" : ch;
  }
  return out;
}

/**
 * Encode a build to a SALT string, reporting which steps could not be
 * mapped. Steps whose name has no SALT table entry are skipped (their
 * raw names are returned in `skipped`) — never thrown on.
 *
 * The table's kind wins over `step.kind`: e.g. a step this repo files
 * as a structure named "OrbitalCommand" still encodes as SALT morph 0.
 */
export function encodeSaltDetailed(
  title: string,
  steps: ReadonlyArray<SaltStep>,
  options: SaltEncodeOptions = {},
): SaltEncodeResult {
  const header =
    VERSION_CHAR +
    sanitizeMeta(title) +
    "|" +
    sanitizeMeta(options.author ?? "") +
    "|" +
    sanitizeMeta(options.description ?? "") +
    "|~";
  const skipped: string[] = [];
  let body = "";
  for (const step of steps) {
    const item = resolveSaltItem(step.name);
    if (!item) {
      skipped.push(step.name);
      continue;
    }
    body +=
      encodeSupply(step.supply) +
      encodeTime(step.timeSec) +
      encChar(TYPE_CODES[item.kind]) +
      encChar(item.id);
  }
  return { salt: header + body, skipped };
}

/** Encode a build to a SALT string, silently skipping unknown items. */
export function encodeSalt(title: string, steps: ReadonlyArray<SaltStep>): string {
  return encodeSaltDetailed(title, steps).salt;
}
