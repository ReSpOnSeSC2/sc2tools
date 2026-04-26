/**
 * Shared canonical catalog of key-timing buildings — JS edition.
 *
 * KEEP-IN-SYNC NOTICE
 * -------------------
 * This file mirrors `analytics/timing_catalog.py` (which is itself
 * duplicated across the two Python repos). The taxonomy here MUST match
 * the Python source-of-truth, otherwise the SPA will display buildings
 * the desktop app doesn't know about (or vice versa).
 *
 * This file is consumed by both:
 *   - `stream-overlay-backend/analyzer.js` (Node / CommonJS)
 *   - `public/analyzer/index.html`         (browser / global)
 *
 * Hence the UMD-lite footer: in Node we attach to `module.exports`, in
 * the browser we attach to `window.TimingCatalog`.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.TimingCatalog = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * One key-timing building.
   *   token        — substring matched against build-log lines.
   *   displayName  — human-readable label ("Spawning Pool").
   *   internalName — sc2reader unit name; stable key for downstream use.
   *   iconFile     — lowercase filename under SC2-Overlay/icons/buildings/.
   *   tier         — 1=opener, 2=tech switch, 3=late tech.
   *   category     — opener | production | tech | expansion | defense.
   */
  function tok(token, displayName, internalName, iconFile, tier, category) {
    return Object.freeze({
      token: token,
      displayName: displayName,
      internalName: internalName,
      iconFile: iconFile,
      tier: tier,
      category: category,
    });
  }

  // Canonical order matches the Python catalog.
  var ZERG = Object.freeze([
    tok('Hatchery',        'Hatchery',          'Hatchery',         'hatchery.png',         1, 'expansion'),
    tok('Pool',            'Spawning Pool',     'SpawningPool',     'spawningpool.png',     1, 'tech'),
    tok('Extractor',       'Extractor',         'Extractor',        'extractor.png',        1, 'production'),
    tok('Evolution',       'Evolution Chamber', 'EvolutionChamber', 'evolutionchamber.png', 1, 'tech'),
    tok('RoachWarren',     'Roach Warren',      'RoachWarren',      'roachwarren.png',      1, 'production'),
    tok('BanelingNest',    'Baneling Nest',     'BanelingNest',     'banelingnest.png',     2, 'production'),
    tok('Lair',            'Lair',              'Lair',             'lair.png',             2, 'expansion'),
    tok('HydraliskDen',    'Hydralisk Den',     'HydraliskDen',     'hydraliskden.png',     2, 'production'),
    tok('LurkerDen',       'Lurker Den',        'LurkerDen',        'lurkerden.png',        2, 'production'),
    tok('Spire',           'Spire',             'Spire',            'spire.png',            2, 'production'),
    tok('InfestationPit',  'Infestation Pit',   'InfestationPit',   'infestationpit.png',   2, 'tech'),
    tok('Nydus',           'Nydus Network',     'NydusNetwork',     'nydusnetwork.png',     2, 'tech'),
    tok('Hive',            'Hive',              'Hive',             'hive.png',             3, 'expansion'),
    tok('UltraliskCavern', 'Ultralisk Cavern',  'UltraliskCavern',  'ultraliskcavern.png',  3, 'production'),
    tok('GreaterSpire',    'Greater Spire',     'GreaterSpire',     'greaterspire.png',     3, 'production'),
  ]);

  var PROTOSS = Object.freeze([
    tok('Nexus',            'Nexus',             'Nexus',            'nexus.png',            1, 'expansion'),
    tok('Pylon',            'Pylon',             'Pylon',            'pylon.png',            1, 'production'),
    tok('Assimilator',      'Assimilator',       'Assimilator',      'assimilator.png',      1, 'production'),
    tok('Gateway',          'Gateway',           'Gateway',          'gateway.png',          1, 'production'),
    tok('WarpGate',         'Warp Gate',         'WarpGate',         'warpgate.png',         1, 'production'),
    tok('Forge',            'Forge',             'Forge',            'forge.png',            1, 'tech'),
    tok('Cybernetics',      'Cybernetics Core',  'CyberneticsCore',  'cyberneticscore.png',  1, 'tech'),
    tok('PhotonCannon',     'Photon Cannon',     'PhotonCannon',     'photoncannon.png',     1, 'defense'),
    tok('ShieldBattery',    'Shield Battery',    'ShieldBattery',    'shieldbattery.png',    1, 'defense'),
    tok('Twilight',         'Twilight Council',  'TwilightCouncil',  'twilightcouncil.png',  2, 'tech'),
    tok('RoboticsFacility', 'Robotics Facility', 'RoboticsFacility', 'roboticsfacility.png', 2, 'production'),
    tok('Stargate',         'Stargate',          'Stargate',         'stargate.png',         2, 'production'),
    tok('TemplarArchive',   'Templar Archives',  'TemplarArchive',   'templararchive.png',   3, 'tech'),
    tok('DarkShrine',       'Dark Shrine',       'DarkShrine',       'darkshrine.png',       3, 'tech'),
    tok('RoboticsBay',      'Robotics Bay',      'RoboticsBay',      'roboticsbay.png',      3, 'tech'),
    tok('FleetBeacon',      'Fleet Beacon',      'FleetBeacon',      'fleetbeacon.png',      3, 'tech'),
  ]);

  var TERRAN = Object.freeze([
    tok('CommandCenter',     'Command Center',     'CommandCenter',     'commandcenter.png',     1, 'expansion'),
    tok('OrbitalCommand',    'Orbital Command',    'OrbitalCommand',    'orbitalcommand.png',    1, 'expansion'),
    tok('SupplyDepot',       'Supply Depot',       'SupplyDepot',       'supplydepot.png',       1, 'production'),
    tok('Refinery',          'Refinery',           'Refinery',          'refinery.png',          1, 'production'),
    tok('Barracks',          'Barracks',           'Barracks',          'barracks.png',          1, 'production'),
    tok('EngineeringBay',    'Engineering Bay',    'EngineeringBay',    'engineeringbay.png',    1, 'tech'),
    tok('Bunker',            'Bunker',             'Bunker',            'bunker.png',            1, 'defense'),
    tok('MissileTurret',     'Missile Turret',     'MissileTurret',     'missileturret.png',     1, 'defense'),
    tok('Factory',           'Factory',            'Factory',           'factory.png',           2, 'production'),
    tok('GhostAcademy',      'Ghost Academy',      'GhostAcademy',      'ghostacademy.png',      2, 'tech'),
    tok('Starport',          'Starport',           'Starport',          'starport.png',          2, 'production'),
    tok('Armory',            'Armory',             'Armory',            'armory.png',            2, 'tech'),
    tok('FusionCore',        'Fusion Core',        'FusionCore',        'fusioncore.png',        3, 'tech'),
    tok('PlanetaryFortress', 'Planetary Fortress', 'PlanetaryFortress', 'planetaryfortress.png', 3, 'expansion'),
  ]);

  var RACE_BUILDINGS = Object.freeze({ Z: ZERG, P: PROTOSS, T: TERRAN });

  // internal_name -> token (cross-race lookup, used by the SPA frontend
  // for icon/displayName resolution).
  var BY_INTERNAL = (function () {
    var m = Object.create(null);
    Object.keys(RACE_BUILDINGS).forEach(function (race) {
      RACE_BUILDINGS[race].forEach(function (t) { m[t.internalName] = t; });
    });
    return Object.freeze(m);
  })();

  var RACE_ALIASES = {
    z: 'Z', zerg: 'Z',
    p: 'P', protoss: 'P', toss: 'P',
    t: 'T', terran: 'T',
  };

  function normalizeRace(race) {
    if (race == null) return '';
    var s = String(race).trim().toLowerCase();
    if (!s) return '';
    return RACE_ALIASES[s] || '';
  }

  function matchupLabel(myRace, oppRace) {
    var my = normalizeRace(myRace);
    var opp = normalizeRace(oppRace);
    if (!my || !opp) return '';
    return my + 'v' + opp;
  }

  // Memoize the union-by-display-order computation. Hot path: every
  // game in opponentDetail() and every render of MedianTimingsGrid.
  var _relevantCache = Object.create(null);

  function relevantTokens(myRace, oppRace) {
    var my = normalizeRace(myRace);
    var opp = normalizeRace(oppRace);
    if (!my || !opp) return [];
    var key = my + '|' + opp;
    var cached = _relevantCache[key];
    if (cached) return cached.slice();
    var seen = Object.create(null);
    var out = [];
    [my, opp].forEach(function (race) {
      RACE_BUILDINGS[race].forEach(function (t) {
        if (seen[t.internalName]) return;
        seen[t.internalName] = true;
        out.push(t);
      });
    });
    _relevantCache[key] = out;
    return out.slice();
  }

  function tokenByInternalName(internalName) {
    return BY_INTERNAL[internalName] || null;
  }

  return {
    RACE_BUILDINGS: RACE_BUILDINGS,
    ZERG: ZERG,
    PROTOSS: PROTOSS,
    TERRAN: TERRAN,
    normalizeRace: normalizeRace,
    matchupLabel: matchupLabel,
    relevantTokens: relevantTokens,
    tokenByInternalName: tokenByInternalName,
  };
});
