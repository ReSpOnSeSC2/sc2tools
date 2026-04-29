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
  if (!data || data.version !== 2 || !Array.isArray(data.builds)) {
    return { version: 2, builds: [] };
  }
  return data;
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
    tier: body.tier === undefined ? null : body.tier,
    description: body.description || '',
    win_conditions: body.win_conditions || [],
    loses_to: body.loses_to || [],
    transitions_into: body.transitions_into || [],
    signature: body.signature,
    tolerance_sec: body.tolerance_sec,
    min_match_score: body.min_match_score,
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
    'name', 'race', 'vs_race', 'tier', 'description',
    'win_conditions', 'loses_to', 'transitions_into',
    'signature', 'tolerance_sec', 'min_match_score',
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

function extractGameEvents(game) {
  if (Array.isArray(game.events)) return game.events;
  const out = [];
  const log = game.early_build_log || game.my_early_build_log
    || game.opp_early_build_log || game.build_log || game.my_build_log
    || game.opp_build_log;
  if (Array.isArray(log)) {
    for (const line of log) {
      const ev = parseLogLine(line);
      if (ev && !EVENT_NOISE_RE.test(ev.what)) out.push(ev);
    }
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
function scoreSignature(events, candidate, tol) {
  let matched = 0;
  for (const sig of candidate.signature || []) {
    for (const ev of events) {
      if (ev.what !== sig.what) continue;
      if (Math.abs((ev.t || 0) - sig.t) <= tol) {
        matched += sig.weight || 0;
        break;
      }
    }
  }
  return matched;
}

/**
 * Walk meta_database games scoring against a single candidate.
 * Used by /preview-matches before save.
 *
 * @param {object} metaDb
 * @param {object} candidate
 * @returns {{matches: Array<object>, scanned: number}}
 */
function previewMatchesAgainst(metaDb, candidate) {
  const matches = [];
  let scanned = 0;
  const tol = candidate.tolerance_sec || DEFAULT_TOLERANCE_SEC;
  const threshold = candidate.min_match_score || DEFAULT_MIN_MATCH_SCORE;
  const totalWeight = (candidate.signature || []).reduce((acc, s) => acc + (s.weight || 0), 0);
  if (totalWeight <= 0) return { matches, scanned };
  for (const buildName of Object.keys(metaDb)) {
    const games = (metaDb[buildName] && metaDb[buildName].games) || [];
    for (const g of games) {
      scanned += 1;
      if (matches.length >= PREVIEW_LIMIT) break;
      const events = extractGameEvents(g);
      if (!events.length) continue;
      const score = scoreSignature(events, candidate, tol) / totalWeight;
      if (score >= threshold) {
        matches.push({ build_name: buildName, game_id: g.game_id || null, score });
      }
    }
    if (matches.length >= PREVIEW_LIMIT) break;
  }
  return { matches, scanned };
}

/**
 * Pick the best-matching build for a game's events. Returns
 * {name, score} or null when nothing crosses min_match_score.
 *
 * @param {Array<object>} events
 * @param {Array<object>} builds
 * @returns {{name: string, score: number}|null}
 */
function bestMatch(events, builds) {
  let best = null;
  for (const b of builds) {
    if (!Array.isArray(b.signature) || b.signature.length === 0) continue;
    const tol = b.tolerance_sec || DEFAULT_TOLERANCE_SEC;
    const totalWeight = b.signature.reduce((acc, s) => acc + (s.weight || 0), 0);
    if (totalWeight <= 0) continue;
    const score = scoreSignature(events, b, tol) / totalWeight;
    if (score >= (b.min_match_score || DEFAULT_MIN_MATCH_SCORE)) {
      if (!best || score > best.score) best = { name: b.name, score };
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
function pickSignatureFromEvents(events) {
  const candidates = (events || []).filter((ev) =>
    ev && typeof ev.what === 'string' &&
    CANDIDATE_RE.test(ev.what) &&
    !SKIP_TOKENS.has(ev.what)
  );
  const ranked = candidates.map((ev) => ({ ev, tier: pickTier(ev.what) }));
  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return b.tier - a.tier;  // higher tier first
    return a.ev.t - b.ev.t;                          // earlier within tier
  });
  const picked = [];
  const seen = new Set();
  for (const r of ranked) {
    if (seen.has(r.ev.what)) continue;
    seen.add(r.ev.what);
    picked.push({ t: r.ev.t, what: r.ev.what, weight: 1.0 });
    if (picked.length >= AUTO_PICK_CAP) break;
  }
  picked.sort((a, b) => a.t - b.t);  // natural reading order in the editor
  return picked;
}

const CANDIDATE_RE = /^(Build|Research|Morph|Train)[A-Z]/;
const AUTO_PICK_CAP = 12;

// Tier 0 — never auto-picked. Townhalls, workers, basic supply. These
// appear in EVERY game and don't carry strategy signal.
const SKIP_TOKENS = new Set([
  // Townhalls (initial only — morphed Lair/Hive/OC are tech moves)
  'BuildNexus', 'BuildCommandCenter', 'BuildHatchery',
  // Workers
  'TrainProbe', 'TrainSCV', 'TrainDrone', 'TrainMULE',
  // Basic supply (Overseer is a tech morph, NOT skipped)
  'BuildPylon', 'BuildSupplyDepot', 'TrainOverlord',
  'MorphSupplyDepotLowered', 'MorphSupplyDepotRaised',
  // Worker rallies / cosmetic (defense in depth on top of the build_log filter)
  'BuildOverlordTransport',
]);

// Tier 3 — highest priority. Key combat units + key tech upgrades.
// These are the strategy commitments most users care about reading.
const TIER3_TOKENS = new Set([
  // Protoss units
  'TrainStalker', 'TrainSentry', 'TrainAdept', 'TrainPhoenix', 'TrainOracle',
  'TrainVoidRay', 'TrainTempest', 'TrainCarrier', 'TrainMothership',
  'TrainImmortal', 'TrainColossus', 'TrainDisruptor', 'TrainObserver',
  'TrainWarpPrism', 'TrainHighTemplar', 'TrainDarkTemplar', 'MorphArchon',
  // Terran units
  'TrainMarauder', 'TrainReaper', 'TrainHellion', 'TrainHellbat',
  'TrainSiegeTank', 'TrainCyclone', 'TrainThor', 'TrainWidowMine',
  'TrainBanshee', 'TrainVikingFighter', 'TrainMedivac', 'TrainLiberator',
  'TrainRaven', 'TrainBattlecruiser', 'TrainGhost',
  // Zerg units (Train + Morph variants)
  'TrainQueen', 'TrainRoach', 'MorphBaneling', 'TrainHydralisk',
  'MorphLurker', 'MorphRavager', 'TrainMutalisk', 'TrainCorruptor',
  'MorphBroodLord', 'MorphOverseer', 'TrainInfestor', 'TrainViper',
  'TrainSwarmHost', 'TrainUltralisk',
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

module.exports = {
  // I/O
  atomicWriteJson, readJsonOrNull, readCustomFile, readMergedList,
  // Identity / shape
  getAuthorDisplay, slugify, uniqueIdFor, normalizeBuild, applyPatch, findById,
  // Events
  parseLogLine, extractGameEvents, scoreSignature,
  // Matching
  previewMatchesAgainst, bestMatch, countGames, moveGame, pickSignatureFromEvents,
  // Constants (re-exported for the router and tests)
  DEFAULT_TOLERANCE_SEC, DEFAULT_MIN_MATCH_SCORE, PREVIEW_LIMIT, ID_PATTERN,
};
