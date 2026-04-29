/**
 * Stage 7.5 — Build editor helpers (pure JS, no React).
 *
 * Companion to `build-editor-modal.babel.js`. Exposes:
 *   - SPA event -> signature-token (`what`) mapping that mirrors the
 *     server-side parseLogLine convention in routes/custom_builds_helpers.js.
 *   - Auto-pick selection mirroring pickSignatureFromEvents (same regex /
 *     same cap of 12) so the modal can pre-check rows before any network
 *     round trip.
 *   - Debounce + focus-trap helpers used by the modal.
 *   - Default name derivation + slug helpers for the editor's draft.
 *
 * KEEP-IN-SYNC NOTICE — the auto-pick regex and verb prefixes here MUST
 * match `routes/custom_builds_helpers.js` (parseLogLine + pickSignatureFromEvents).
 * If those change, this file changes too, otherwise the SPA's pre-checked
 * rows will diverge from what /from-game returns.
 *
 * UMD-lite footer attaches the API to `window.BuildEditorHelpers` in the
 * browser and `module.exports` under Node so the file is also testable
 * with the existing Jest harness.
 *
 * @module build-editor-helpers
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.BuildEditorHelpers = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- Constants (mirrored from the backend; do not divert) ---------------
  var AUTO_PICK_REGEX = /^(Build|Research|Morph|Train)[A-Z]/;
  var SIG_TOKEN_REGEX = /^[A-Za-z][A-Za-z0-9]*$/;
  var SIG_VERB_REGEX = /^(Build|Train|Research|Morph)\s+([A-Za-z][A-Za-z0-9]*)$/;
  var SIG_PREFIXED_REGEX = /^(Build|Train|Research|Morph)[A-Z][A-Za-z0-9]*$/;
  var ZERG_UNIT_MORPHS = /^(Baneling|Ravager|Lurker|LurkerMP|BroodLord|Overseer)$/;
  // Stage 7.5: defense-in-depth filter for cosmetic events (beacons,
  // sprays, dance commands). Matches the analyzer.js _BUILD_LOG_NOISE_RE
  // — keep both in sync. spaEventToWhat returns null for these so they
  // never appear in /from-game payloads even if the server-side filter is
  // bypassed (e.g. caller posts events[] directly).
  var NOISE_RE = /^(Beacon|Reward|Spray)/;
  var AUTO_PICK_CAP = 12;
  var AUTO_PICK_WEIGHT = 1.0;
  var USER_ADD_WEIGHT = 0.5;
  var DEFAULT_TOLERANCE_SEC = 30;  // mirror routes/custom_builds_helpers.js
  var DEFAULT_MIN_MATCH_SCORE = 0.55;  // mirror routes/custom_builds_helpers.js
  var TIME_NUDGE_MAX_SEC = 60;  // Stage 7.5: was 15 — let users shift target up to a minute.
  var ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/;
  var DESC_MAX_CHARS = 500;
  var NAME_MIN_CHARS = 3;
  var NAME_MAX_CHARS = 120;
  var STRATEGY_NOTE_MAX_CHARS = 280;
  var STRATEGY_NOTE_MAX_ITEMS = 20;

  // ---- Event -> signature token mapping ----------------------------------

  /**
   * Map a single SPA timeline event ({time, name, category, is_building, race})
   * to a server-canonical signature token like 'BuildStargate' or
   * 'ResearchBlink'. Returns null when the event can't be mapped (bad name,
   * empty noun).
   *
   * @param {object} ev The SPA event from /games/:id/build-order
   * @returns {string|null}
   *
   * Example:
   *   spaEventToWhat({time:225, name:'Stargate', is_building:true})
   *     => 'BuildStargate'
   *   spaEventToWhat({time:340, name:'Research Blink'})
   *     => 'ResearchBlink'
   */
  function spaEventToWhat(ev) {
    if (!ev) return null;
    var raw = String(ev.name == null ? '' : ev.name).trim();
    if (!raw) return null;
    if (NOISE_RE.test(raw)) return null;
    var m = SIG_VERB_REGEX.exec(raw);
    if (m) return m[1] + m[2];
    if (SIG_PREFIXED_REGEX.test(raw)) return raw;
    var noun = raw.replace(/[^A-Za-z0-9]/g, '');
    if (!noun || !/^[A-Za-z]/.test(noun)) return null;
    if (ev.is_building) return 'Build' + noun;
    if (ev.category === 'upgrade') return 'Research' + noun;
    if (ev.race === 'Zerg' && ev.category === 'unit' && ZERG_UNIT_MORPHS.test(noun)) {
      return 'Morph' + noun;
    }
    if (ev.category === 'unit') return 'Train' + noun;
    return 'Build' + noun;
  }

  /**
   * Convert an SPA event to a candidate row the editor renders in the
   * left column. Adds `what` (mapped) and a stable `key` so React can
   * reconcile, but preserves the original SPA fields for display.
   *
   * @param {object} ev
   * @param {number} idx
   * @returns {object|null}
   */
  function spaEventToRow(ev, idx) {
    var what = spaEventToWhat(ev);
    if (!what || !SIG_TOKEN_REGEX.test(what) || what.length > 80) return null;
    var t = clampTime(Number(ev.time) || 0);
    return {
      key: 't' + t + ':' + what + ':' + idx,
      t: t,
      what: what,
      display: ev.display || ev.name || what,
      time_display: ev.time_display || formatTime(t),
      race: ev.race || 'Neutral',
      category: ev.category || 'unknown',
      is_building: !!ev.is_building,
    };
  }

  /**
   * Convert the full SPA event list into editor rows. Skips events that
   * don't map cleanly (rare; protects the modal from crashing on garbage
   * catalog rows).
   *
   * @param {Array<object>} events
   * @returns {Array<object>}
   */
  function spaEventsToRows(events) {
    var out = [];
    if (!Array.isArray(events)) return out;
    for (var i = 0; i < events.length; i += 1) {
      var row = spaEventToRow(events[i], i);
      if (row) out.push(row);
    }
    return out;
  }

  // ---- Auto-pick (mirrors pickSignatureFromEvents server-side) ------------

  // Stage 7.5: tiered auto-pick. Same sets as the server-side
  // pickSignatureFromEvents in routes/custom_builds_helpers.js — keep in
  // sync. Skip townhalls/workers/supply, prioritize tech buildings + key
  // units, fall back to production buildings.
  var SKIP_TOKENS = new Set([
    'BuildNexus', 'BuildCommandCenter', 'BuildHatchery',
    'TrainProbe', 'TrainSCV', 'TrainDrone', 'TrainMULE',
    'BuildPylon', 'BuildSupplyDepot', 'TrainOverlord',
    'MorphSupplyDepotLowered', 'MorphSupplyDepotRaised',
    'BuildOverlordTransport',
  ]);
  var TIER3_TOKENS = new Set([
    // Protoss units
    'TrainStalker','TrainSentry','TrainAdept','TrainPhoenix','TrainOracle',
    'TrainVoidRay','TrainTempest','TrainCarrier','TrainMothership',
    'TrainImmortal','TrainColossus','TrainDisruptor','TrainObserver',
    'TrainWarpPrism','TrainHighTemplar','TrainDarkTemplar','MorphArchon',
    // Terran units
    'TrainMarauder','TrainReaper','TrainHellion','TrainHellbat',
    'TrainSiegeTank','TrainCyclone','TrainThor','TrainWidowMine',
    'TrainBanshee','TrainVikingFighter','TrainMedivac','TrainLiberator',
    'TrainRaven','TrainBattlecruiser','TrainGhost',
    // Zerg units
    'TrainQueen','TrainRoach','MorphBaneling','TrainHydralisk',
    'MorphLurker','MorphRavager','TrainMutalisk','TrainCorruptor',
    'MorphBroodLord','MorphOverseer','TrainInfestor','TrainViper',
    'TrainSwarmHost','TrainUltralisk',
    // Key Protoss upgrades
    'ResearchBlink','ResearchCharge','ResearchWarpGate',
    'ResearchPsionicStorm','ResearchExtendedThermalLance',
    'ResearchShadowStride','ResearchVoidRaySpeedUpgrade',
    'ResearchAnionPulseCrystals','ResearchGraviticDrive',
    'ResearchGraviticBoosters',
    // Key Terran upgrades
    'ResearchStimpack','ResearchCombatShield','ResearchConcussiveShells',
    'ResearchSiegeTech','ResearchInfernalPreigniter',
    'ResearchHisecAutoTracking','ResearchPersonalCloaking',
    'ResearchAdvancedBallistics','ResearchBansheeCloak','ResearchBansheeSpeed',
    // Key Zerg upgrades
    'ResearchMetabolicBoost','ResearchAdrenalGlands','ResearchGroovedSpines',
    'ResearchMuscularAugments','ResearchTunnelingClaws',
    'ResearchGlialReconstitution','ResearchBurrow','ResearchPneumatizedCarapace',
    'ResearchCentrifugalHooks','ResearchNeuralParasite',
  ]);
  var TIER2_TOKENS = new Set([
    'BuildCyberneticsCore','BuildTwilightCouncil','BuildRoboticsFacility',
    'BuildRoboticsBay','BuildStargate','BuildFleetBeacon',
    'BuildTemplarArchives','BuildDarkShrine','BuildForge',
    'BuildPhotonCannon','BuildShieldBattery',
    'BuildFactory','BuildStarport','BuildArmory','BuildFusionCore',
    'BuildEngineeringBay','BuildGhostAcademy','BuildBunker',
    'BuildMissileTurret','BuildSensorTower',
    'BuildOrbitalCommand','BuildPlanetaryFortress',
    'BuildBarracksTechLab','BuildBarracksReactor',
    'BuildFactoryTechLab','BuildFactoryReactor',
    'BuildStarportTechLab','BuildStarportReactor',
    'BuildSpawningPool','BuildEvolutionChamber','BuildRoachWarren',
    'BuildBanelingNest','BuildHydraliskDen','BuildSpire',
    'BuildInfestationPit','BuildUltraliskCavern','BuildNydusNetwork',
    'BuildNydusWorm','BuildSporeCrawler','BuildSpineCrawler',
    'MorphLair','MorphHive','MorphGreaterSpire','MorphLurkerDen',
  ]);

  function pickTier(what) {
    if (TIER3_TOKENS.has(what)) return 3;
    if (TIER2_TOKENS.has(what)) return 2;
    return 1;
  }

  /**
   * Compute the set of row keys that should be default-checked. Mirrors
   * pickSignatureFromEvents in routes/custom_builds_helpers.js — same
   * tier ordering, same skip set, same cap. Sort: higher tier first,
   * then earlier-in-time within tier.
   *
   * @param {Array<object>} rows From spaEventsToRows
   * @returns {Set<string>} keys of rows that should start checked
   */
  function autoPickRowKeys(rows) {
    var keys = new Set();
    if (!Array.isArray(rows) || !rows.length) return keys;
    var candidates = [];
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      if (!AUTO_PICK_REGEX.test(r.what)) continue;
      if (SKIP_TOKENS.has(r.what)) continue;
      candidates.push({ row: r, tier: pickTier(r.what) });
    }
    candidates.sort(function (a, b) {
      if (a.tier !== b.tier) return b.tier - a.tier;
      return a.row.t - b.row.t;
    });
    var seen = new Set();
    for (var j = 0; j < candidates.length && keys.size < AUTO_PICK_CAP; j += 1) {
      var w = candidates[j].row.what;
      if (seen.has(w)) continue;
      seen.add(w);
      keys.add(candidates[j].row.key);
    }
    return keys;
  }

  /**
   * Build the initial signature array from a row set. Each entry is a
   * fresh signature event {t, what, weight} suitable for /from-game's
   * events[] payload or for direct posting to /preview-matches.
   *
   * @param {Array<object>} rows All editor rows
   * @param {Set<string>} checkedKeys
   * @param {Object<string,number>} weightByKey Weight overrides keyed by row.key
   * @param {Object<string,number>} timeNudgeByKey Time nudges (-15..+15) keyed by row.key
   * @returns {Array<{t:number, what:string, weight:number}>}
   */
  function buildSignatureFromRows(rows, checkedKeys, weightByKey, timeNudgeByKey) {
    var sig = [];
    if (!Array.isArray(rows)) return sig;
    var weights = weightByKey || {};
    var nudges = timeNudgeByKey || {};
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      if (!checkedKeys || !checkedKeys.has(r.key)) continue;
      var nudge = clampTimeNudge(Number(nudges[r.key]) || 0);
      var t = clampTime(r.t + nudge);
      var w = weights[r.key];
      if (w == null) w = AUTO_PICK_WEIGHT;
      var weight = clampWeight(Number(w));
      if (weight <= 0) continue;
      sig.push({ t: t, what: r.what, weight: weight });
    }
    return sig;
  }

  // ---- Numeric clamps ----------------------------------------------------

  function clampTime(t) {
    var n = Math.round(Number(t) || 0);
    if (n < 0) return 0;
    if (n > 1800) return 1800;
    return n;
  }

  function clampTimeNudge(n) {
    var v = Math.round(Number(n) || 0);
    if (v < -TIME_NUDGE_MAX_SEC) return -TIME_NUDGE_MAX_SEC;
    if (v > TIME_NUDGE_MAX_SEC) return TIME_NUDGE_MAX_SEC;
    return v;
  }

  function clampWeight(w) {
    var v = Number(w);
    if (!isFinite(v) || v < 0) return 0;
    if (v > 5) return 5;
    return v;
  }

  function clampTolerance(t) {
    var v = Math.round(Number(t) || DEFAULT_TOLERANCE_SEC);
    if (v < 5) return 5;
    if (v > 60) return 60;
    return v;
  }

  function clampMinMatchScore(s) {
    var v = Number(s);
    if (!isFinite(v) || v < 0.3) return 0.3;
    if (v > 1.0) return 1.0;
    return Math.round(v * 100) / 100;
  }

  // ---- Misc helpers ------------------------------------------------------

  function formatTime(t) {
    var sec = clampTime(t);
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ':' + (s < 10 ? '0' + s : '' + s);
  }

  /**
   * Generate a default build name from the source game's data. Falls back
   * to "Custom build" if neither race is known.
   *
   * @param {{my_race?:string, opp_race?:string, opp_strategy?:string}} data
   * @returns {string}
   */
  function deriveDefaultName(data) {
    if (!data || typeof data !== 'object') return 'Custom build';
    var my = String(data.my_race || data.myRace || '').trim();
    var opp = String(data.opp_race || '').trim();
    var strat = String(data.opp_strategy || '').trim();
    if (my && opp) {
      var matchup = my.charAt(0).toUpperCase() + 'v' + opp.charAt(0).toUpperCase();
      if (strat) return matchup + ' — ' + strat;
      return matchup + ' — Custom';
    }
    return strat || 'Custom build';
  }

  /**
   * Slugify a build name into a kebab-case id candidate. Always returns a
   * value matching ID_PATTERN; appends '-build' when the slug would be
   * shorter than 3 chars.
   *
   * @param {string} name
   * @returns {string}
   */
  function slugify(name) {
    var base = String(name == null ? '' : name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 78);
    if (base.length < 3) base = (base || 'custom') + '-build';
    if (!/^[a-z0-9]/.test(base)) base = 'b-' + base;
    if (!/[a-z0-9]$/.test(base)) base = base + '-x';
    return base.slice(0, 80);
  }

  // ---- Debounce ----------------------------------------------------------

  /**
   * Trailing-edge debounce. The wrapped function fires at most once per
   * `wait` window after the most recent call.
   *
   * @param {Function} fn
   * @param {number} wait Milliseconds
   * @returns {Function} The debounced function with a `.cancel()` method.
   */
  function debounce(fn, wait) {
    var timer = null;
    function debounced() {
      var args = arguments;
      var ctx = this;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        fn.apply(ctx, args);
      }, wait);
    }
    debounced.cancel = function () {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    return debounced;
  }

  // ---- Focus trap --------------------------------------------------------

  var FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  /**
   * Constrain Tab navigation to within a container element. Call the
   * returned function on the keydown event; it returns true when it
   * trapped the key (caller should preventDefault), false otherwise.
   *
   * @param {HTMLElement} container
   * @returns {(ev: KeyboardEvent) => boolean}
   */
  function makeFocusTrap(container) {
    return function trap(ev) {
      if (!container || ev.key !== 'Tab') return false;
      var focusables = Array.prototype.slice.call(
        container.querySelectorAll(FOCUSABLE_SELECTOR)
      ).filter(function (el) {
        return el.offsetParent !== null || el === document.activeElement;
      });
      if (!focusables.length) return false;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      var active = document.activeElement;
      if (ev.shiftKey && (active === first || !container.contains(active))) {
        last.focus();
        return true;
      }
      if (!ev.shiftKey && (active === last || !container.contains(active))) {
        first.focus();
        return true;
      }
      return false;
    };
  }

  // ---- Empty-draft sanitiser ---------------------------------------------

  /**
   * Apply form-side validation + clamps before posting to /custom-builds.
   * Returns {ok, errors, payload} so the caller can render inline errors.
   *
   * @param {object} draft Whatever the editor has in state
   * @returns {{ok:boolean, errors:object, payload:object}}
   */
  function sanitiseDraft(draft) {
    var errors = {};
    var d = draft || {};
    var name = String(d.name || '').trim();
    if (name.length < NAME_MIN_CHARS) errors.name = 'Need at least ' + NAME_MIN_CHARS + ' chars.';
    if (name.length > NAME_MAX_CHARS) errors.name = 'Max ' + NAME_MAX_CHARS + ' chars.';
    var description = String(d.description || '').slice(0, DESC_MAX_CHARS);
    var sig = Array.isArray(d.signature) ? d.signature : [];
    if (sig.length === 0) errors.signature = 'Pick at least one event.';
    if (sig.length > 60) errors.signature = 'At most 60 events.';
    for (var i = 0; i < sig.length; i += 1) {
      if (!SIG_TOKEN_REGEX.test(sig[i].what || '')) {
        errors.signature = 'Event ' + (i + 1) + ' has an invalid token.';
        break;
      }
    }
    var payload = {
      name: name,
      description: description,
      race: d.race || 'Protoss',
      vs_race: d.vs_race || 'Random',
      tier: d.tier || null,
      win_conditions: clipStrings(d.win_conditions),
      loses_to: clipStrings(d.loses_to),
      transitions_into: clipStrings(d.transitions_into),
      signature: sig,
      tolerance_sec: clampTolerance(d.tolerance_sec),
      min_match_score: clampMinMatchScore(d.min_match_score),
      source_replay_id: d.source_replay_id || null,
    };
    if (d.id) payload.id = d.id;
    return { ok: Object.keys(errors).length === 0, errors: errors, payload: payload };
  }

  function clipStrings(arr) {
    if (!Array.isArray(arr)) return [];
    var out = [];
    for (var i = 0; i < arr.length && out.length < STRATEGY_NOTE_MAX_ITEMS; i += 1) {
      var s = String(arr[i] == null ? '' : arr[i]).trim();
      if (!s) continue;
      out.push(s.slice(0, STRATEGY_NOTE_MAX_CHARS));
    }
    return out;
  }

  // ---- Public API --------------------------------------------------------
  return {
    // event mapping
    spaEventToWhat: spaEventToWhat,
    spaEventToRow: spaEventToRow,
    spaEventsToRows: spaEventsToRows,
    // auto-pick
    autoPickRowKeys: autoPickRowKeys,
    buildSignatureFromRows: buildSignatureFromRows,
    // clamps
    clampTime: clampTime,
    clampTimeNudge: clampTimeNudge,
    clampWeight: clampWeight,
    clampTolerance: clampTolerance,
    clampMinMatchScore: clampMinMatchScore,
    // misc
    formatTime: formatTime,
    deriveDefaultName: deriveDefaultName,
    slugify: slugify,
    debounce: debounce,
    makeFocusTrap: makeFocusTrap,
    sanitiseDraft: sanitiseDraft,
    // constants
    AUTO_PICK_CAP: AUTO_PICK_CAP,
    AUTO_PICK_WEIGHT: AUTO_PICK_WEIGHT,
    USER_ADD_WEIGHT: USER_ADD_WEIGHT,
    DEFAULT_TOLERANCE_SEC: DEFAULT_TOLERANCE_SEC,
    DEFAULT_MIN_MATCH_SCORE: DEFAULT_MIN_MATCH_SCORE,
    TIME_NUDGE_MAX_SEC: TIME_NUDGE_MAX_SEC,
    DESC_MAX_CHARS: DESC_MAX_CHARS,
    NAME_MIN_CHARS: NAME_MIN_CHARS,
    NAME_MAX_CHARS: NAME_MAX_CHARS,
    STRATEGY_NOTE_MAX_CHARS: STRATEGY_NOTE_MAX_CHARS,
    STRATEGY_NOTE_MAX_ITEMS: STRATEGY_NOTE_MAX_ITEMS,
    ID_PATTERN: ID_PATTERN,
  };
});
