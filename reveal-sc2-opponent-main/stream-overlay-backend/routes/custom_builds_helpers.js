/**
 * CUSTOM BUILDS -- HELPERS
 * ============================================================
 * Pure utilities used by `routes/custom-builds.js`. Kept in a
 * sibling module so the router stays under the 800-line cap from
 * the engineering preamble.
 *
 * No express, no I/O leaks, no globals -- every function is
 * unit-testable in isolation.
 *
 * Example:
 *   const { readMergedList, bestMatch } = require('./custom_builds_helpers');
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TOLERANCE_SEC = 30;  // Stage 7.5: was 15 — build-order timings drift 15-25s naturally between same-opening games.
const DEFAULT_MIN_MATCH_SCORE = 0.55;  // Stage 7.5: was 0.6 — slight majority of weighted events is enough.
const PREVIEW_LIMIT = 200;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/;

/**
 * Atomically write a JSON file (.tmp + fsync + rename).
 *
 * Example:
 *   atomicWriteJson('/data/foo.json', { hi: 1 });
 *
 * @param {string} filePath
 * @param {object} data
 */
function atomicWriteJson(filePath, data) {
  const tmp = filePath + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

/**
 * Read a JSON file with BOM stripping. Null on missing/empty.
 *
 * @param {string} filePath
 * @returns {object|null}
 */
function readJsonOrNull(filePath) {
  if (!fs.existsSync(filePath)) return null;
  let raw = fs.readFileSync(filePath, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

/**
 * Read the custom_builds.json file or default to the empty
 * v2 shape. Files in any other shape are coerced empty so the
 * Python loader (responsible for v1->v2 migration) never has
 * to fight with the Node side over the same file.
 *
 * @param {string} customPath
 * @returns {{version: number, builds: Array<object>}}
 */
function readCustomFile(customPath) {
  const data = readJsonOrNull(customPath);
  if (!data || !Array.isArray(data.builds)) {
    return { version: SCHEMA_VERSION, builds: [] };
  }
  if (data.version === SCHEMA_VERSION) return data;
  if (data.version === 2) {
    // Stage 7.5b: in-memory migrate. Caller may persist via the next save.
    const migrated = data.builds.map(migrateBuildV2ToV3).filter(Boolean);
    return { version: SCHEMA_VERSION, builds: migrated };
  }
  return { version: SCHEMA_VERSION, builds: [] };
}

/**
 * Build the merged list of customs and community-cache builds.
 * Customs win on id collision; "deleted" customs are hidden.
 *
 * @param {string} customPath
 * @param {string} cachePath
 * @returns {{builds: Array<object>, customCount: number, cacheCount: number}}
 */
function readMergedList(customPath, cachePath) {
  const custom = readCustomFile(customPath);
  const cache = readJsonOrNull(cachePath) || { builds: [] };
  const seen = new Set();
  const merged = [];
  for (const b of custom.builds) {
    if (b.sync_state === 'deleted') continue;
    seen.add(b.id);
    merged.push({ ...b, source: 'custom' });
  }
  for (const b of cache.builds || []) {
    if (seen.has(b.id)) continue;
    merged.push({ ...b, source: 'community' });
  }
  return {
    builds: merged,
    customCount: custom.builds.length,
    cacheCount: (cache.builds || []).length,
  };
}

/**
 * Read profile.json display name; "local" when absent.
 *
 * @param {string} dataDir
 * @returns {string}
 */
function getAuthorDisplay(dataDir) {
  try {
    const profile = readJsonOrNull(path.join(dataDir, 'profile.json'));
    if (!profile) return 'local';
    const name = profile.display_name || profile.battle_tag || profile.preferred_player_name_in_replays;
    return typeof name === 'string' && name.length > 0 ? name.slice(0, 80) : 'local';
  } catch (_) {
    return 'local';
  }
}

/**
 * Convert a name into a kebab-case id. Caller must uniquify.
 *
 * @param {string} name
 * @returns {string}
 */
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Generate a unique id from a name against an existing id set.
 *
 * @param {string} name
 * @param {Set<string>} existing
 * @returns {string}
 */
function uniqueIdFor(name, existing) {
  const base = slugify(name) || 'build';
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = (base + '-' + i).slice(0, 80);
    if (!existing.has(candidate)) return candidate;
  }
  return (base.slice(0, 70) + '-' + crypto.randomBytes(3).toString('hex')).slice(0, 80);
}

/**
 * Normalise an inbound build to the v2 wire shape.
 *
 * @param {object} body
 * @param {object} defaults
 * @returns {object}
 */
function normalizeBuild(body, defaults) {
  return {
    id: body.id,
    name: body.name,
    race: body.race,
    vs_race: body.vs_race,
    skill_level: SKILL_LEVELS.has(body.skill_level) ? body.skill_level : null,
    description: body.description || '',
    win_conditions: body.win_conditions || [],
    loses_to: body.loses_to || [],
    transitions_into: body.transitions_into || [],
    rules: Array.isArray(body.rules) ? body.rules : [],
    source_replay_id: body.source_replay_id || null,
    created_at: defaults.created_at,
    updated_at: defaults.updated_at,
    author: defaults.author,
    sync_state: defaults.sync_state,
  };
}

/**
 * Apply a partial body to an existing build (whitelisted keys).
 *
 * @param {object} prev
 * @param {object} patch
 * @returns {object}
 */
function applyPatch(prev, patch) {
  const allow = [
    'name', 'race', 'vs_race', 'skill_level', 'description',
    'win_conditions', 'loses_to', 'transitions_into', 'rules',
  ];
  const next = { ...prev };
  for (const key of allow) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      next[key] = patch[key];
    }
  }
  next.updated_at = new Date().toISOString();
  next.sync_state = 'pending';
  return next;
}

/**
 * Find a build by id in a list.
 *
 * @param {Array<object>} builds
 * @param {string} id
 * @returns {{build: object|null, index: number}}
 */
function findById(builds, id) {
  for (let i = 0; i < builds.length; i++) {
    if (builds[i].id === id) return { build: builds[i], index: i };
  }
  return { build: null, index: -1 };
}

/**
 * Parse a "MM:SS Build/Train Foo" build-log line into {t, what}.
 *
 * @param {string} line
 * @returns {{t: number, what: string}|null}
 */
// Stage 7.5: parser for build_log entries stored in meta_database.json.
// The on-disk format from analyzer.js parseBuildLogLines is "[M:SS] Token"
// where Token is already in concatenated form like "BuildNexus" or
// "RewardDanceStalker". The previous regex required UNBRACKETED time
// prefix and assumed verb+space+noun, which made it return null on every
// real entry — silently breaking the entire match engine. Fix: accept
// both formats and recognise already-concatenated tokens.
function parseLogLine(line) {
  if (typeof line !== 'string') return null;
  const m = line.match(/^\[?(\d+):(\d+)\]?\s+(.+?)\s*$/);
  if (!m) return null;
  const t = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const rest = m[3].trim();
  // "Verb Noun" with space (legacy / unit test format)
  const verbed = rest.match(/^(Build|Train|Research|Morph)\s+([A-Za-z][A-Za-z0-9]*)$/);
  if (verbed) return { t, what: verbed[1] + verbed[2] };
  // Single-token rest (the on-disk format)
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(rest)) {
    // Already prefixed (BuildNexus, TrainStalker, ResearchBlink, MorphLair)?
    if (/^(Build|Train|Research|Morph)[A-Z]/.test(rest)) return { t, what: rest };
    // Bare noun (Stalker, Pylon, Blink) — prepend Build as the catch-all verb
    return { t, what: 'Build' + rest };
  }
  return null;
}

/**
 * Extract a normalised event list from a meta_database game.
 *
 * @param {object} game
 * @returns {Array<{t: number, what: string}>}
 */
// Stage 7.5: order swapped so the matcher scores against MY build_log
// when matching MY signature events. Previous order
// (opp_early_build_log first) meant a Protoss signature was being scored
// against Terran/Zerg opponent events — guaranteed 0 matches. The
// EVENT_NOISE_RE drop mirrors the analyzer.js cosmetic filter so the
// Reward/Beacon/Spray noise that pre-7.5 replays still have on disk
// doesn't pollute scoring (they all sit at t=0 and would otherwise
// inflate match scores spuriously).
const EVENT_NOISE_RE = /^(?:Build|Train|Research|Morph)?(?:Beacon|Reward|Spray)/;

// Stage 7.5b: extract the USER's events from a meta_database game.
// Reads only `build_log` (the canonical user-side field for this data
// layout — my_*_build_log is empty for every game in the corpus, and
// opp_*_build_log is by definition the opponent's events which would
// corrupt matches). Drops cosmetic Beacon/Reward/Spray entries via
// EVENT_NOISE_RE. Race filtering is intentionally NOT applied — earlier
// experiments showed (a) the user's build_log is reliably their own
// events for >99% of games (11214/11266 contain BuildNexus), so no race
// filter is needed for correctness, and (b) the rare cross-race noise
// is harmless because rule.name is itself race-specific (e.g. a rule
// for BuildSpawningPool only matches games where someone built one,
// which is what the user wants to find).
function extractGameEvents(game) {
  if (!game) return [];
  if (Array.isArray(game.events)) return game.events;
  const out = [];
  const log = Array.isArray(game.build_log) ? game.build_log : [];
  for (const line of log) {
    const ev = parseLogLine(line);
    if (!ev) continue;
    if (EVENT_NOISE_RE.test(ev.what)) continue;
    out.push(ev);
  }
  return out;
}



/**
 * Compute the unnormalised match weight of a candidate against
 * an event list. Each signature event contributes its weight at
 * most once even if multiple events match.
 *
 * @param {Array<{t: number, what: string}>} events
 * @param {object} candidate
 * @param {number} tol
 * @returns {number}
 */
// Stage 7.5b: v2 scoreSignature retired. v3 uses evaluateRule (boolean
// per rule, all-must-pass) instead of weighted-sum scoring.
function scoreSignature() {
  throw new Error('scoreSignature is removed in v3 — use evaluateRule / evaluateRules');
}

/**
 * Walk meta_database games scoring against a single candidate.
 * Used by /preview-matches before save.
 *
 * @param {object} metaDb
 * @param {object} candidate
 * @returns {{matches: Array<object>, scanned: number}}
 */
// Stage 7.5b: rule-based preview. Walks every game in metaDb, runs the
// candidate's rules against each game's event list, and bucketed into
// matches (all rules pass) and almostMatches (failed exactly 1 — used by
// the SPA's 'almost matches' band so users see what's close and why).
function previewMatchesV3(metaDb, candidate) {
  const matches = [];
  const almostMatches = [];
  let scanned = 0;
  const rules = (candidate && Array.isArray(candidate.rules)) ? candidate.rules : [];
  if (!rules.length) return { matches, almostMatches, scanned, truncated: false };
  for (const buildName of Object.keys(metaDb)) {
    const games = (metaDb[buildName] && metaDb[buildName].games) || [];
    for (const g of games) {
      scanned += 1;
      if (matches.length >= PREVIEW_LIMIT && almostMatches.length >= PREVIEW_LIMIT) break;
      const events = extractGameEvents(g);
      const r = evaluateRules(events, rules);
      if (r.failedIndices.length === 0) {
        if (matches.length < PREVIEW_LIMIT) {
          matches.push({ build_name: buildName, game_id: g.game_id || null });
        }
      } else if (r.failedIndices.length === 1) {
        if (almostMatches.length < PREVIEW_LIMIT) {
          const idx = r.failedIndices[0];
          almostMatches.push({
            build_name: buildName,
            game_id: g.game_id || null,
            failed_index: idx,
            failed_reason: r.reasons[idx] || 'rule failed',
          });
        }
      }
    }
    if (matches.length >= PREVIEW_LIMIT && almostMatches.length >= PREVIEW_LIMIT) break;
  }
  return {
    matches,
    almostMatches,
    scanned,
    truncated: matches.length >= PREVIEW_LIMIT || almostMatches.length >= PREVIEW_LIMIT,
  };
}

/**
 * Pick the best-matching build for a game's events. Returns
 * {name, score} or null when nothing crosses min_match_score.
 *
 * @param {Array<object>} events
 * @param {Array<object>} builds
 * @returns {{name: string, score: number}|null}
 */
// Stage 7.5b: v3 best match. Returns the FIRST build whose every rule
// passes against the events. Tiebreak by name (alphabetical) for
// deterministic reclassify. Score is always 1.0 for compatibility with
// callers that read .score (rule-eval is boolean).
function bestMatchV3(events, builds) {
  let best = null;
  for (const b of builds) {
    if (!Array.isArray(b.rules) || b.rules.length === 0) continue;
    const r = evaluateRules(events, b.rules);
    if (r.failedIndices.length === 0) {
      if (!best || (b.name || '') < (best.name || '')) best = { name: b.name, score: 1.0 };
    }
  }
  return best;
}

/**
 * Count every game in a meta_database.json structure.
 *
 * @param {object} meta
 * @returns {number}
 */
function countGames(meta) {
  let n = 0;
  for (const k of Object.keys(meta)) {
    n += (meta[k] && meta[k].games && meta[k].games.length) || 0;
  }
  return n;
}

/**
 * Move a game record between build buckets in meta_database.
 *
 * @param {object} meta
 * @param {string} from
 * @param {string} to
 * @param {number} idx
 */
function moveGame(meta, from, to, idx) {
  const game = meta[from].games.splice(idx, 1)[0];
  if (!meta[to]) meta[to] = { games: [] };
  if (!Array.isArray(meta[to].games)) meta[to].games = [];
  meta[to].games.push(game);
}

/**
 * Pick a small spread of strategy-defining events to seed a draft
 * signature. Stage 7.5: tiered selection — skip generic econ events
 * (townhall, workers, basic supply) and prioritize tech buildings + key
 * units before falling back to production buildings. The previous
 * implementation took the first 12 Build/Train/Research/Morph events,
 * which on a fresh game meant Nexus -> Pylon -> Probe -> Probe ... and
 * the actual tech-defining moments (Stargate, Phoenix, Twilight, Blink)
 * fell off the cap. With the tiered ordering a typical Protoss opening
 * picks Cyber Core -> Stargate -> Phoenix -> Oracle -> Twilight -> Blink
 * -> Robo -> Immortal etc., which is what users actually care about.
 *
 * Mirrored client-side in public/analyzer/components/build-editor-helpers.js
 * (autoPickRowKeys) so the SPA pre-checks the same rows the server would
 * have picked. Keep the two in sync.
 *
 * @param {Array<{t:number, what:string}>} events
 * @returns {Array<{t:number, what:string, weight:number}>}
 */
// Stage 7.5b: v3 auto-pick — emit RULES not signature events. Same tiered
// ordering as the v2 pickSignature but each picked event becomes a
// 'before' rule with time_lt = event.t + AUTO_PICK_TIME_BUFFER_SEC. Cap
// at AUTO_PICK_RULES_CAP because rule-eval is strict (boolean per rule);
// fewer-but-precise rules give better recall to start.
// Stage 7.5b update: removed auto-pick. The previous implementation
// (top 5 tier-defined events from the source replay) produced suggestions
// that weren't actually good — time_lt anchored to one specific replay's
// timing, no consideration of what's discriminative across the user's
// library. User feedback: 'really bad, dont recommend any rules'.
//
// The modal now opens with 0 rules. The source-replay column visually
// highlights tech-worthy events (TIER2/TIER3 sets) so the user knows
// what's worth clicking [+] on.
//
// Future enhancement: a 'Suggest rules' button that does a discriminative
// analysis against the meta DB — find events that distinguish this game
// from games in OTHER buckets. That would produce actually-useful
// suggestions but needs a new endpoint.
function pickRulesFromEvents(_events) {
  return [];
}

const CANDIDATE_RE = /^(Build|Research|Morph|Train)[A-Z]/;
const AUTO_PICK_CAP = 12;

// Tier 0 — never auto-picked. Townhalls, workers, basic supply. These
// appear in EVERY game and don't carry strategy signal.
// Stage 7.5b note: the user's build_log uses 'Build' verb prefix for
// EVERYTHING (units, morphs, upgrades) because parseLogLine defaults
// verb to 'Build' when the on-disk line has no verb. So 'BuildProbe' /
// 'BuildOverlord' are how workers + supply appear, NOT 'TrainProbe'.
// Both variants listed below for defense in depth (synthetic test data
// uses Train*).
const SKIP_TOKENS = new Set([
  // Townhalls
  'BuildNexus', 'BuildCommandCenter', 'BuildHatchery',
  // Workers (Build* in real data; Train* in tests)
  'BuildProbe', 'BuildSCV', 'BuildDrone', 'BuildMULE',
  'TrainProbe', 'TrainSCV', 'TrainDrone', 'TrainMULE',
  // Basic supply
  'BuildPylon', 'BuildSupplyDepot', 'BuildOverlord',
  'TrainOverlord',
  'MorphSupplyDepotLowered', 'MorphSupplyDepotRaised',
  'BuildOverlordTransport',
]);

// Tier 3 — highest priority. Key combat units + key tech upgrades.
// These are the strategy commitments most users care about reading.
const TIER3_TOKENS = new Set([
  // Real data uses Build* prefix for units; both listed for compat.
  // Protoss units (Build* + Train*)
  'BuildStalker','BuildSentry','BuildAdept','BuildPhoenix','BuildOracle',
  'BuildVoidRay','BuildTempest','BuildCarrier','BuildMothership',
  'BuildImmortal','BuildColossus','BuildDisruptor','BuildObserver',
  'BuildWarpPrism','BuildHighTemplar','BuildDarkTemplar','BuildArchon',
  'BuildZealot',
  'TrainStalker', 'TrainSentry', 'TrainAdept', 'TrainPhoenix', 'TrainOracle',
  'TrainVoidRay', 'TrainTempest', 'TrainCarrier', 'TrainMothership',
  'TrainImmortal', 'TrainColossus', 'TrainDisruptor', 'TrainObserver',
  'TrainWarpPrism', 'TrainHighTemplar', 'TrainDarkTemplar', 'MorphArchon',
  // Terran units
  'TrainMarauder', 'TrainReaper', 'TrainHellion', 'TrainHellbat',
  'TrainSiegeTank', 'TrainCyclone', 'TrainThor', 'TrainWidowMine',
  'TrainBanshee', 'TrainVikingFighter', 'TrainMedivac', 'TrainLiberator',
  'TrainRaven', 'TrainBattlecruiser', 'TrainGhost',
  // Terran Build*
  'BuildMarauder','BuildReaper','BuildHellion','BuildHellbat',
  'BuildSiegeTank','BuildCyclone','BuildThor','BuildWidowMine',
  'BuildBanshee','BuildViking','BuildVikingFighter','BuildVikingAssault',
  'BuildMedivac','BuildLiberator','BuildRaven','BuildBattlecruiser',
  'BuildGhost','BuildMarine',
  // Zerg (Train + Morph + Build variants)
  'TrainQueen', 'TrainRoach', 'MorphBaneling', 'TrainHydralisk',
  'MorphLurker', 'MorphRavager', 'TrainMutalisk', 'TrainCorruptor',
  'MorphBroodLord', 'MorphOverseer', 'TrainInfestor', 'TrainViper',
  'TrainSwarmHost', 'TrainUltralisk',
  'BuildQueen','BuildRoach','BuildBaneling','BuildHydralisk',
  'BuildLurker','BuildRavager','BuildMutalisk','BuildCorruptor',
  'BuildBroodLord','BuildOverseer','BuildInfestor','BuildViper',
  'BuildSwarmHost','BuildUltralisk','BuildZergling',
  // Key Protoss upgrades
  'ResearchBlink', 'ResearchCharge', 'ResearchWarpGate',
  'ResearchPsionicStorm', 'ResearchExtendedThermalLance',
  'ResearchShadowStride', 'ResearchVoidRaySpeedUpgrade',
  'ResearchAnionPulseCrystals', 'ResearchGraviticDrive',
  'ResearchGraviticBoosters',
  // Key Terran upgrades
  'ResearchStimpack', 'ResearchCombatShield', 'ResearchConcussiveShells',
  'ResearchSiegeTech', 'ResearchInfernalPreigniter',
  'ResearchHisecAutoTracking', 'ResearchPersonalCloaking',
  'ResearchAdvancedBallistics', 'ResearchBansheeCloak',
  'ResearchBansheeSpeed',
  // Key Zerg upgrades
  'ResearchMetabolicBoost', 'ResearchAdrenalGlands', 'ResearchGroovedSpines',
  'ResearchMuscularAugments', 'ResearchTunnelingClaws',
  'ResearchGlialReconstitution', 'ResearchBurrow', 'ResearchPneumatizedCarapace',
  'ResearchCentrifugalHooks', 'ResearchNeuralParasite',
]);

// Tier 2 — tech buildings + key tech morphs. The "what tech tree did
// they open" layer. Also mid-priority defensive structures.
const TIER2_TOKENS = new Set([
  // Protoss tech buildings
  'BuildCyberneticsCore', 'BuildTwilightCouncil', 'BuildRoboticsFacility',
  'BuildRoboticsBay', 'BuildStargate', 'BuildFleetBeacon',
  'BuildTemplarArchives', 'BuildDarkShrine', 'BuildForge',
  'BuildPhotonCannon', 'BuildShieldBattery',
  // Terran tech buildings + upgrades
  'BuildFactory', 'BuildStarport', 'BuildArmory', 'BuildFusionCore',
  'BuildEngineeringBay', 'BuildGhostAcademy', 'BuildBunker',
  'BuildMissileTurret', 'BuildSensorTower',
  'BuildOrbitalCommand', 'BuildPlanetaryFortress',
  'BuildBarracksTechLab', 'BuildBarracksReactor',
  'BuildFactoryTechLab', 'BuildFactoryReactor',
  'BuildStarportTechLab', 'BuildStarportReactor',
  // Zerg tech buildings + key morphs
  'BuildSpawningPool', 'BuildEvolutionChamber', 'BuildRoachWarren',
  'BuildBanelingNest', 'BuildHydraliskDen', 'BuildSpire',
  'BuildInfestationPit', 'BuildUltraliskCavern', 'BuildNydusNetwork',
  'BuildNydusWorm', 'BuildSporeCrawler', 'BuildSpineCrawler',
  'MorphLair', 'MorphHive', 'MorphGreaterSpire', 'MorphLurkerDen',
]);

function pickTier(what) {
  if (TIER3_TOKENS.has(what)) return 3;
  if (TIER2_TOKENS.has(what)) return 2;
  return 1;  // default: production buildings, basic units (Gateway, Barracks, Marine, Zealot)
}

// ===================================================================
// Stage 7.5b — v3 rule engine
// ===================================================================
// Boolean per-rule, all-must-pass. The router calls evaluateRules per
// game to compute matches + almost-matches for the build editor preview.
//
// Rule types (matches data/custom_builds.schema.json):
//   - before     : event 'name' must occur with t < time_lt
//                  (or |t - time_lt| <= tol if tol present)
//   - not_before : event 'name' must NOT occur with t < time_lt
//   - count_max  : count(name occurrences with t < time_lt) <= count
//   - count_min  : count(name occurrences with t < time_lt) >= count

const SCHEMA_VERSION = 3;
const SKILL_LEVELS = new Set([
  'bronze', 'silver', 'gold', 'platinum',
  'diamond', 'master', 'grandmaster',
]);
const RULE_TYPES = new Set(['before', 'not_before', 'count_max', 'count_min']);
const AUTO_PICK_RULES_CAP = 5;
const AUTO_PICK_TIME_BUFFER_SEC = 30;
const TIME_LT_MIN = 1;
const TIME_LT_MAX = 1800;

function clampRuleTime(t) {
  const v = Math.round(Number(t) || 0);
  if (v < TIME_LT_MIN) return TIME_LT_MIN;
  if (v > TIME_LT_MAX) return TIME_LT_MAX;
  return v;
}

function formatTime(t) {
  const sec = Math.max(0, Math.round(Number(t) || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ':' + (s < 10 ? '0' + s : '' + s);
}

/**
 * Evaluate one rule. Returns {ok: bool, reason?: string}.
 * `reason` is human-readable for failed rules (used in the SPA almost-matches band).
 *
 * @param {Array<{t:number, what:string}>} events
 * @param {object} rule
 * @returns {{ok: boolean, reason?: string}}
 */
function evaluateRule(events, rule) {
  if (!rule || typeof rule !== 'object' || !RULE_TYPES.has(rule.type)) {
    return { ok: false, reason: 'malformed rule' };
  }
  const evts = Array.isArray(events) ? events : [];
  const name = rule.name;
  const cutoff = rule.time_lt;
  switch (rule.type) {
    case 'before': {
      const tol = (typeof rule.tol === 'number' && rule.tol > 0) ? rule.tol : null;
      if (tol !== null) {
        const hit = evts.find((e) => e.what === name && Math.abs(e.t - cutoff) <= tol);
        return hit ? { ok: true } : {
          ok: false,
          reason: name + ' not within ±' + tol + 's of ' + formatTime(cutoff),
        };
      }
      const hit = evts.find((e) => e.what === name && e.t < cutoff);
      return hit ? { ok: true } : {
        ok: false,
        reason: name + ' never built before ' + formatTime(cutoff),
      };
    }
    case 'not_before': {
      const hit = evts.find((e) => e.what === name && e.t < cutoff);
      return hit ? {
        ok: false,
        reason: name + ' built at ' + formatTime(hit.t) + ' (rule says NOT before ' + formatTime(cutoff) + ')',
      } : { ok: true };
    }
    case 'count_max': {
      const cnt = evts.filter((e) => e.what === name && e.t < cutoff).length;
      return cnt <= rule.count ? { ok: true } : {
        ok: false,
        reason: name + ' count ' + cnt + ' exceeds max ' + rule.count + ' by ' + formatTime(cutoff),
      };
    }
    case 'count_min': {
      const cnt = evts.filter((e) => e.what === name && e.t < cutoff).length;
      return cnt >= rule.count ? { ok: true } : {
        ok: false,
        reason: name + ' count ' + cnt + ' below min ' + rule.count + ' by ' + formatTime(cutoff),
      };
    }
    default:
      return { ok: false, reason: 'unknown rule type: ' + rule.type };
  }
}

/**
 * Evaluate ALL rules. Returns parallel arrays.
 *
 * @param {Array<{t:number, what:string}>} events
 * @param {Array<object>} rules
 * @returns {{passes: boolean[], reasons: (string|null)[], failedIndices: number[]}}
 */
function evaluateRules(events, rules) {
  const passes = [];
  const reasons = [];
  const failedIndices = [];
  for (let i = 0; i < rules.length; i++) {
    const r = evaluateRule(events, rules[i]);
    passes.push(r.ok);
    reasons.push(r.ok ? null : (r.reason || 'rule failed'));
    if (!r.ok) failedIndices.push(i);
  }
  return { passes, reasons, failedIndices };
}

/**
 * Convert a v2-shape build (signature/tier/tolerance_sec/min_match_score)
 * to v3 (rules/skill_level). Each signature event becomes a 'before' rule
 * with time_lt = sig.t + AUTO_PICK_TIME_BUFFER_SEC. Cap at the same
 * AUTO_PICK_RULES_CAP. Tier (S/A/B/C) maps to null skill_level — user
 * sets it explicitly in v3 since the semantics changed.
 *
 * @param {object} b
 * @returns {object|null}
 */
function migrateBuildV2ToV3(b) {
  if (!b || typeof b !== 'object') return null;
  if (Array.isArray(b.rules)) return b;  // already v3
  const sig = Array.isArray(b.signature) ? b.signature : [];
  const rules = [];
  for (const s of sig) {
    if (!s || typeof s.what !== 'string' || typeof s.t !== 'number') continue;
    rules.push({
      type: 'before',
      name: s.what,
      time_lt: clampRuleTime(s.t + AUTO_PICK_TIME_BUFFER_SEC),
    });
    if (rules.length >= AUTO_PICK_RULES_CAP) break;
  }
  if (rules.length === 0) {
    rules.push({ type: 'before', name: 'BuildNexus', time_lt: 30 });  // placeholder
  }
  const out = {
    id: b.id || 'migrated-' + Date.now().toString(36),
    name: b.name || 'Migrated build',
    race: b.race || 'Protoss',
    vs_race: b.vs_race || 'Any',
    skill_level: null,
    description: b.description || '',
    win_conditions: Array.isArray(b.win_conditions) ? b.win_conditions : [],
    loses_to: Array.isArray(b.loses_to) ? b.loses_to : [],
    transitions_into: Array.isArray(b.transitions_into) ? b.transitions_into : [],
    rules,
    source_replay_id: b.source_replay_id || null,
    created_at: b.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    author: b.author || 'unknown',
    sync_state: 'pending',
  };
  if (typeof b.remote_version === 'number') out.remote_version = b.remote_version;
  if (typeof b.upvotes === 'number') out.upvotes = b.upvotes;
  if (typeof b.downvotes === 'number') out.downvotes = b.downvotes;
  return out;
}

module.exports = {
  // I/O
  atomicWriteJson, readJsonOrNull, readCustomFile, readMergedList,
  // Identity / shape
  getAuthorDisplay, slugify, uniqueIdFor, normalizeBuild, applyPatch, findById,
  // Events
  parseLogLine, extractGameEvents,
  // v3 rule engine
  evaluateRule, evaluateRules, previewMatchesV3, bestMatchV3,
  pickRulesFromEvents, migrateBuildV2ToV3, formatTime,
  // Generic helpers
  countGames, moveGame,
  // Constants
  PREVIEW_LIMIT, ID_PATTERN, SKILL_LEVELS, SCHEMA_VERSION,
  AUTO_PICK_RULES_CAP, AUTO_PICK_TIME_BUFFER_SEC,
  // Deprecated v2 exports (throw if called) — kept so require() of stale
  // callers fails loudly in dev rather than silently
  scoreSignature,
};
