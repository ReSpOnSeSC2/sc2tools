/* ============================================================
 * SC2 Overlay -- Icon Registry
 *
 * Central lookup that maps races, leagues, build names, and
 * strategy names to the icon files in `icons/`. The mapping
 * works in two stages:
 *
 *   1. Explicit table   -- exact name match for the most common
 *      strategies. Always wins.
 *   2. Keyword fallback -- if no explicit entry exists, scans the
 *      strategy name for known unit / building / upgrade keywords
 *      and assembles icons from whatever it finds. This means
 *      custom user-defined builds get icons automatically.
 *
 * If an icon file is missing on disk, the <img> in the DOM still
 * gets created but its `onerror` handler hides it, so the existing
 * text/emoji fallback shows through. The overlay never breaks.
 *
 * Public surface (attached to window.SC2Icons):
 *   raceIcon(raceLetterOrName)   -> string  url or ''
 *   leagueIcon(leagueName)       -> string  url or ''
 *   strategyIcons(strategyName)  -> string[] up to 3 urls
 *   resultIcon(resultName)       -> string  url or ''
 *   miscIcon(key)                -> string  url or ''
 * ============================================================ */

(function () {
    'use strict';

    const BASE = 'icons/';

    // ---- Race ------------------------------------------------------
    // SVGs sourced from sc2-pulse/sc2-icons (MIT). See icons/CREDITS.md.
    const RACES = {
        Z: 'races/zerg.svg',
        P: 'races/protoss.svg',
        T: 'races/terran.svg',
        R: 'races/random.svg',
        Zerg:    'races/zerg.svg',
        Protoss: 'races/protoss.svg',
        Terran:  'races/terran.svg',
        Random:  'races/random.svg'
    };

    // ---- League ----------------------------------------------------
    // SVGs sourced from sc2-pulse/sc2-icons (MIT). See icons/CREDITS.md.
    const LEAGUES = {
        Bronze:      'leagues/bronze.svg',
        Silver:      'leagues/silver.svg',
        Gold:        'leagues/gold.svg',
        Platinum:    'leagues/platinum.svg',
        Diamond:     'leagues/diamond.svg',
        Master:      'leagues/master.svg',
        Grandmaster: 'leagues/grandmaster.svg'
    };

    // ---- Match result ---------------------------------------------
    const RESULTS = {
        Victory: 'result/victory.png',
        Defeat:  'result/defeat.png',
        Tie:     'result/tie.png'
    };

    // ---- Misc ------------------------------------------------------
    const MISC = {
        cheese:   'misc/cheese.png',
        fire:     'misc/fire.png',
        rampage:  'misc/rampage.png',
        mmrUp:    'misc/mmr-up.png',
        mmrDown:  'misc/mmr-down.png'
    };

    // ---- Keyword -> icon path ------------------------------------
    // Matched as case-insensitive substrings against strategy/build
    // names. The keyword fallback walks this list once and collects
    // up to 3 icons, preferring building icons over unit icons over
    // upgrade icons (so a "Stargate Phoenix" build gets the building
    // and the unit, not two of either).
    //
    // Names use the SC2 in-game naming the analyzer engine emits
    // (see core/build_definitions.py KNOWN_BUILDINGS / SKIP_UNITS).
    const KEYWORDS = [
        // ---------- Buildings ----------
        { kw: 'spawningpool',    icon: 'buildings/spawningpool.png',     kind: 'building' },
        { kw: 'spawning pool',   icon: 'buildings/spawningpool.png',     kind: 'building' },
        { kw: 'pool',            icon: 'buildings/spawningpool.png',     kind: 'building' },
        { kw: 'banelingnest',    icon: 'buildings/banelingnest.png',     kind: 'building' },
        { kw: 'baneling nest',   icon: 'buildings/banelingnest.png',     kind: 'building' },
        { kw: 'roachwarren',     icon: 'buildings/roachwarren.png',      kind: 'building' },
        { kw: 'roach warren',    icon: 'buildings/roachwarren.png',      kind: 'building' },
        { kw: 'hydraliskden',    icon: 'buildings/hydraliskden.png',     kind: 'building' },
        { kw: 'hydralisk den',   icon: 'buildings/hydraliskden.png',     kind: 'building' },
        { kw: 'lurkerden',       icon: 'buildings/lurkerden.png',        kind: 'building' },
        { kw: 'spire',           icon: 'buildings/spire.png',            kind: 'building' },
        { kw: 'nydus',           icon: 'buildings/nydusnetwork.png',     kind: 'building' },
        { kw: 'hatchery',        icon: 'buildings/hatchery.png',         kind: 'building' },
        { kw: 'hatch',           icon: 'buildings/hatchery.png',         kind: 'building' },
        { kw: 'lair',            icon: 'buildings/lair.png',             kind: 'building' },
        { kw: 'hive',            icon: 'buildings/hive.png',             kind: 'building' },
        { kw: 'evolutionchamber',icon: 'buildings/evolutionchamber.png', kind: 'building' },
        { kw: 'extractor',       icon: 'buildings/extractor.png',        kind: 'building' },
        { kw: 'infestationpit',  icon: 'buildings/infestationpit.png',   kind: 'building' },
        { kw: 'ultraliskcavern', icon: 'buildings/ultraliskcavern.png',  kind: 'building' },

        { kw: 'gateway',         icon: 'buildings/gateway.png',          kind: 'building' },
        { kw: 'warpgate',        icon: 'buildings/warpgate.png',         kind: 'building' },
        { kw: 'photoncannon',    icon: 'buildings/photoncannon.png',     kind: 'building' },
        { kw: 'cannon',          icon: 'buildings/photoncannon.png',     kind: 'building' },
        { kw: 'forge',           icon: 'buildings/forge.png',            kind: 'building' },
        { kw: 'cyberneticscore', icon: 'buildings/cyberneticscore.png',  kind: 'building' },
        { kw: 'twilightcouncil', icon: 'buildings/twilightcouncil.png',  kind: 'building' },
        { kw: 'twilight',        icon: 'buildings/twilightcouncil.png',  kind: 'building' },
        { kw: 'roboticsfacility',icon: 'buildings/roboticsfacility.png', kind: 'building' },
        { kw: 'robo',            icon: 'buildings/roboticsfacility.png', kind: 'building' },
        { kw: 'roboticsbay',     icon: 'buildings/roboticsbay.png',      kind: 'building' },
        { kw: 'stargate',        icon: 'buildings/stargate.png',         kind: 'building' },
        { kw: 'fleetbeacon',     icon: 'buildings/fleetbeacon.png',      kind: 'building' },
        { kw: 'darkshrine',      icon: 'buildings/darkshrine.png',       kind: 'building' },
        { kw: 'templararchive',  icon: 'buildings/templararchive.png',   kind: 'building' },
        { kw: 'nexus',           icon: 'buildings/nexus.png',            kind: 'building' },
        { kw: 'assimilator',     icon: 'buildings/assimilator.png',      kind: 'building' },
        { kw: 'shieldbattery',   icon: 'buildings/shieldbattery.png',    kind: 'building' },
        { kw: 'pylon',           icon: 'buildings/pylon.png',            kind: 'building' },

        { kw: 'commandcenter',   icon: 'buildings/commandcenter.png',    kind: 'building' },
        { kw: 'orbitalcommand',  icon: 'buildings/orbitalcommand.png',   kind: 'building' },
        { kw: 'orbital',         icon: 'buildings/orbitalcommand.png',   kind: 'building' },
        { kw: 'planetary',       icon: 'buildings/planetaryfortress.png',kind: 'building' },
        { kw: 'barracks',        icon: 'buildings/barracks.png',         kind: 'building' },
        { kw: 'rax',             icon: 'buildings/barracks.png',         kind: 'building' },
        { kw: 'factory',         icon: 'buildings/factory.png',          kind: 'building' },
        { kw: 'starport',        icon: 'buildings/starport.png',         kind: 'building' },
        { kw: 'engineeringbay',  icon: 'buildings/engineeringbay.png',   kind: 'building' },
        { kw: 'armory',          icon: 'buildings/armory.png',           kind: 'building' },
        { kw: 'fusioncore',      icon: 'buildings/fusioncore.png',       kind: 'building' },
        { kw: 'ghostacademy',    icon: 'buildings/ghostacademy.png',     kind: 'building' },
        { kw: 'sensortower',     icon: 'buildings/sensortower.png',      kind: 'building' },
        { kw: 'missileturret',   icon: 'buildings/missileturret.png',    kind: 'building' },
        { kw: 'turret',          icon: 'buildings/missileturret.png',    kind: 'building' },
        { kw: 'bunker',          icon: 'buildings/bunker.png',           kind: 'building' },
        { kw: 'refinery',        icon: 'buildings/refinery.png',         kind: 'building' },
        { kw: 'supplydepot',     icon: 'buildings/supplydepot.png',      kind: 'building' },

        // ---------- Units ----------
        // Zerg
        { kw: 'zergling',     icon: 'units/zergling.png',     kind: 'unit' },
        { kw: 'speedling',    icon: 'units/zergling.png',     kind: 'unit' },
        { kw: 'ling',         icon: 'units/zergling.png',     kind: 'unit' },
        { kw: 'baneling',     icon: 'units/baneling.png',     kind: 'unit' },
        { kw: 'bane',         icon: 'units/baneling.png',     kind: 'unit' },
        { kw: 'queen',        icon: 'units/queen.png',        kind: 'unit' },
        { kw: 'roach',        icon: 'units/roach.png',        kind: 'unit' },
        { kw: 'ravager',      icon: 'units/ravager.png',      kind: 'unit' },
        { kw: 'overseer',     icon: 'units/overseer.png',     kind: 'unit' },
        { kw: 'hydralisk',    icon: 'units/hydralisk.png',    kind: 'unit' },
        { kw: 'hydra',        icon: 'units/hydralisk.png',    kind: 'unit' },
        { kw: 'lurker',       icon: 'units/lurker.png',       kind: 'unit' },
        { kw: 'mutalisk',     icon: 'units/mutalisk.png',     kind: 'unit' },
        { kw: 'muta',         icon: 'units/mutalisk.png',     kind: 'unit' },
        { kw: 'corruptor',    icon: 'units/corruptor.png',    kind: 'unit' },
        { kw: 'broodlord',    icon: 'units/broodlord.png',    kind: 'unit' },
        { kw: 'infestor',     icon: 'units/infestor.png',     kind: 'unit' },
        { kw: 'swarmhost',    icon: 'units/swarmhost.png',    kind: 'unit' },
        { kw: 'viper',        icon: 'units/viper.png',        kind: 'unit' },
        { kw: 'ultralisk',    icon: 'units/ultralisk.png',    kind: 'unit' },
        { kw: 'ultra',        icon: 'units/ultralisk.png',    kind: 'unit' },

        // Protoss
        { kw: 'zealot',       icon: 'units/zealot.png',       kind: 'unit' },
        { kw: 'chargelot',    icon: 'units/zealot.png',       kind: 'unit' },
        { kw: 'stalker',      icon: 'units/stalker.png',      kind: 'unit' },
        { kw: 'sentry',       icon: 'units/sentry.png',       kind: 'unit' },
        { kw: 'adept',        icon: 'units/adept.png',        kind: 'unit' },
        { kw: 'hightemplar',  icon: 'units/hightemplar.png',  kind: 'unit' },
        { kw: 'high templar', icon: 'units/hightemplar.png',  kind: 'unit' },
        { kw: 'darktemplar',  icon: 'units/darktemplar.png',  kind: 'unit' },
        { kw: 'dark templar', icon: 'units/darktemplar.png',  kind: 'unit' },
        { kw: 'dt',           icon: 'units/darktemplar.png',  kind: 'unit' },
        { kw: 'archon',       icon: 'units/archon.png',       kind: 'unit' },
        { kw: 'observer',     icon: 'units/observer.png',     kind: 'unit' },
        { kw: 'immortal',     icon: 'units/immortal.png',     kind: 'unit' },
        { kw: 'colossus',     icon: 'units/colossus.png',     kind: 'unit' },
        { kw: 'disruptor',    icon: 'units/disruptor.png',    kind: 'unit' },
        { kw: 'warpprism',    icon: 'units/warpprism.png',    kind: 'unit' },
        { kw: 'warp prism',   icon: 'units/warpprism.png',    kind: 'unit' },
        { kw: 'phoenix',      icon: 'units/phoenix.png',      kind: 'unit' },
        { kw: 'oracle',       icon: 'units/oracle.png',       kind: 'unit' },
        { kw: 'voidray',      icon: 'units/voidray.png',      kind: 'unit' },
        { kw: 'void ray',     icon: 'units/voidray.png',      kind: 'unit' },
        { kw: 'void',         icon: 'units/voidray.png',      kind: 'unit' },
        { kw: 'tempest',      icon: 'units/tempest.png',      kind: 'unit' },
        { kw: 'carrier',      icon: 'units/carrier.png',      kind: 'unit' },
        { kw: 'mothership',   icon: 'units/mothership.png',   kind: 'unit' },

        // Terran
        { kw: 'marine',       icon: 'units/marine.png',       kind: 'unit' },
        { kw: 'marauder',     icon: 'units/marauder.png',     kind: 'unit' },
        { kw: 'reaper',       icon: 'units/reaper.png',       kind: 'unit' },
        { kw: 'ghost',        icon: 'units/ghost.png',        kind: 'unit' },
        { kw: 'hellion',      icon: 'units/hellion.png',      kind: 'unit' },
        { kw: 'hellbat',      icon: 'units/hellbat.png',      kind: 'unit' },
        { kw: 'widowmine',    icon: 'units/widowmine.png',    kind: 'unit' },
        { kw: 'widow mine',   icon: 'units/widowmine.png',    kind: 'unit' },
        { kw: 'mine',         icon: 'units/widowmine.png',    kind: 'unit' },
        { kw: 'siegetank',    icon: 'units/siegetank.png',    kind: 'unit' },
        { kw: 'siege tank',   icon: 'units/siegetank.png',    kind: 'unit' },
        { kw: 'tank',         icon: 'units/siegetank.png',    kind: 'unit' },
        { kw: 'cyclone',      icon: 'units/cyclone.png',      kind: 'unit' },
        { kw: 'thor',         icon: 'units/thor.png',         kind: 'unit' },
        { kw: 'viking',       icon: 'units/viking.png',       kind: 'unit' },
        { kw: 'medivac',      icon: 'units/medivac.png',      kind: 'unit' },
        { kw: 'liberator',    icon: 'units/liberator.png',    kind: 'unit' },
        { kw: 'banshee',      icon: 'units/banshee.png',      kind: 'unit' },
        { kw: 'raven',        icon: 'units/raven.png',        kind: 'unit' },
        { kw: 'battlecruiser',icon: 'units/battlecruiser.png',kind: 'unit' },
        { kw: 'bc ',          icon: 'units/battlecruiser.png',kind: 'unit' },

        // ---------- Upgrades ----------
        { kw: 'blink',        icon: 'upgrades/blink.png',     kind: 'upgrade' },
        { kw: 'charge',       icon: 'upgrades/charge.png',    kind: 'upgrade' },
        { kw: 'glaive',       icon: 'upgrades/glaive.png',    kind: 'upgrade' },
        { kw: 'speed',        icon: 'upgrades/speed.png',     kind: 'upgrade' },
        { kw: 'cloak',        icon: 'upgrades/cloak.png',     kind: 'upgrade' },
        { kw: 'stim',         icon: 'upgrades/stim.png',      kind: 'upgrade' },
        { kw: 'concussive',   icon: 'upgrades/concussive.png',kind: 'upgrade' },
        { kw: 'combat shield',icon: 'upgrades/combatshield.png',kind:'upgrade' }
    ];

    // ---- Explicit strategy overrides ----------------------------
    // For named strategies where the keyword fallback picks
    // suboptimal icons. Keys must match the analyzer's strategy
    // names exactly (see core/build_definitions.py).
    const STRATEGIES = {
        'Zerg - 12 Pool':                       ['buildings/spawningpool.png', 'units/zergling.png'],
        'Zerg - 13/12 Baneling Bust':           ['buildings/banelingnest.png', 'units/baneling.png'],
        'Zerg - 13/12 Speedling Aggression':    ['units/zergling.png', 'upgrades/speed.png'],
        'Zerg - 17 Hatch 18 Gas 17 Pool':       ['buildings/hatchery.png', 'buildings/spawningpool.png'],
        'Zerg - 1 Base Roach Rush':             ['buildings/roachwarren.png', 'units/roach.png'],
        'Zerg - 2 Base Roach/Ravager All-in':   ['units/roach.png', 'units/ravager.png'],
        'Zerg - 2 Base Muta Rush':              ['buildings/spire.png', 'units/mutalisk.png'],
        'Zerg - 2 Base Nydus':                  ['buildings/nydusnetwork.png'],
        'Zerg - Muta/Ling/Bane Comp':           ['units/mutalisk.png', 'units/baneling.png', 'units/zergling.png'],
        'Zerg - Roach/Ravager Comp':            ['units/roach.png', 'units/ravager.png'],
        'Zerg - Hydra Comp':                    ['units/hydralisk.png'],

        'Protoss - Cannon Rush':                ['buildings/photoncannon.png'],
        'Protoss - Proxy 4 Gate':               ['buildings/gateway.png', 'units/zealot.png'],
        'Protoss - DT Rush':                    ['buildings/darkshrine.png', 'units/darktemplar.png'],
        'Protoss - 4 Gate Rush':                ['buildings/gateway.png', 'units/stalker.png'],
        'Protoss - Glaive Adept Timing':        ['units/adept.png', 'upgrades/glaive.png'],
        'Protoss - Chargelot All-in':           ['units/zealot.png', 'upgrades/charge.png'],
        'Protoss - Stargate Opener':            ['buildings/stargate.png', 'units/voidray.png'],
        'Protoss - Robo Opener':                ['buildings/roboticsfacility.png', 'units/immortal.png'],
        'Protoss - Blink All-In':               ['units/stalker.png', 'upgrades/blink.png'],
        'Protoss - Skytoss Transition':         ['units/carrier.png'],
        'Protoss - Robo Comp':                  ['units/colossus.png', 'units/disruptor.png'],
        'Protoss - Chargelot/Archon Comp':      ['units/zealot.png', 'units/archon.png'],

        'Terran - 2 Gas 3 Reaper 2 Hellion':    ['units/reaper.png', 'units/hellion.png'],
        'Terran - Proxy Rax':                   ['buildings/barracks.png', 'units/marine.png'],
        'Terran - Ghost Rush':                  ['buildings/ghostacademy.png', 'units/ghost.png'],
        'Terran - Cyclone Rush':                ['units/cyclone.png', 'buildings/factory.png'],
        'Terran - Hellbat All-in':              ['units/hellion.png', 'buildings/armory.png'],
        'Terran - Widow Mine Drop':             ['units/widowmine.png', 'units/medivac.png'],
        'Terran - BC Rush':                     ['buildings/fusioncore.png', 'units/battlecruiser.png'],
        'Terran - Banshee Rush':                ['units/banshee.png'],
        'Terran - Fast 3 CC':                   ['buildings/commandcenter.png'],
        'Terran - 1-1-1 Standard':              ['buildings/factory.png', 'buildings/starport.png', 'buildings/barracks.png'],
        'Terran - Proxy Starport Hellion Drop': ['buildings/starport.png', 'units/hellion.png', 'units/medivac.png'],
        'Terran - Standard Bio Tank':           ['units/marine.png', 'units/medivac.png', 'units/siegetank.png'],
        'Terran - Mech Comp':                   ['units/siegetank.png', 'units/thor.png'],
        'Terran - Bio Comp':                    ['units/marine.png', 'units/marauder.png', 'units/medivac.png'],
        'Terran - SkyTerran':                   ['units/battlecruiser.png', 'units/liberator.png'],

        // PvZ user builds
        'PvZ - Carrier Rush':                   ['units/carrier.png'],
        'PvZ - Tempest Rush':                   ['units/tempest.png'],
        'PvZ - 2 Stargate Void Ray':            ['buildings/stargate.png', 'units/voidray.png'],
        'PvZ - 3 Stargate Phoenix':             ['buildings/stargate.png', 'units/phoenix.png'],
        'PvZ - 2 Stargate Phoenix':             ['buildings/stargate.png', 'units/phoenix.png'],
        'PvZ - 7 Gate Glaive/Immortal All-in':  ['units/adept.png', 'units/immortal.png'],
        'PvZ - Adept Glaives (No Robo)':        ['units/adept.png', 'upgrades/glaive.png'],
        'PvZ - Adept Glaives (Robo)':           ['units/adept.png', 'upgrades/glaive.png', 'buildings/roboticsfacility.png'],
        'PvZ - Stargate into Glaives':          ['buildings/stargate.png', 'units/adept.png', 'upgrades/glaive.png'],
        'PvZ - Blink Stalker All-in (2 Base)':  ['units/stalker.png', 'upgrades/blink.png'],
        'PvZ - Archon Drop':                    ['units/archon.png', 'units/warpprism.png'],
        'PvZ - DT drop into Archon Drop':       ['units/darktemplar.png', 'units/warpprism.png'],
        'PvZ - Standard Blink Macro':           ['units/stalker.png', 'upgrades/blink.png'],
        'PvZ - Standard charge Macro':          ['units/zealot.png', 'upgrades/charge.png'],

        // PvP user builds
        'PvP - Proxy 2 Gate':                   ['buildings/gateway.png', 'units/zealot.png'],
        'PvP - Phoenix Style':                  ['units/phoenix.png'],
        'PvP - Blink Stalker Style':            ['units/stalker.png', 'upgrades/blink.png'],
        'PvP - Standard Stargate Opener':       ['buildings/stargate.png'],

        // PvT user builds
        'PvT - Proxy Void Ray/Stargate':        ['buildings/stargate.png', 'units/voidray.png'],
        'PvT - Stargate into Charge':           ['buildings/stargate.png', 'units/zealot.png', 'upgrades/charge.png'],
        'PvT - Stargate into Glaives':          ['buildings/stargate.png', 'units/adept.png', 'upgrades/glaive.png'],
        'PvT - Stargate into Blink':            ['buildings/stargate.png', 'units/stalker.png', 'upgrades/blink.png'],
        'PvT - Stargate Opener':                ['buildings/stargate.png', 'units/voidray.png'],
        'TvP - 1-1-1 One Base':                 ['buildings/barracks.png', 'buildings/factory.png', 'buildings/starport.png'],
        'PvT - Phoenix into Robo':              ['units/phoenix.png', 'buildings/roboticsfacility.png'],
        'PvT - Phoenix Opener':                 ['units/phoenix.png'],
        'PvT - 7 Gate Blink All-in':            ['units/stalker.png', 'upgrades/blink.png'],
        'PvT - 8 Gate Charge All-in':           ['units/zealot.png', 'upgrades/charge.png'],
        'PvT - Standard Charge Macro':          ['units/zealot.png', 'upgrades/charge.png'],
        'PvT - 4 Gate Blink':                   ['units/stalker.png', 'upgrades/blink.png'],
        'PvT - 3 Gate Blink (Macro)':           ['units/stalker.png', 'upgrades/blink.png'],
        'PvT - DT Drop':                        ['units/darktemplar.png', 'units/warpprism.png'],
        'PvT - Robo First':                     ['buildings/roboticsfacility.png', 'units/immortal.png']
    };

    // ---- Lookup helpers --------------------------------------
    function withBase(p) {
        if (!p) return '';
        return BASE + p;
    }

    function raceIcon(raceLetterOrName) {
        if (!raceLetterOrName) return '';
        const k = String(raceLetterOrName).trim();
        const path = RACES[k] || RACES[k.charAt(0).toUpperCase() + k.slice(1).toLowerCase()] ||
                     RACES[k.charAt(0).toUpperCase()];
        return path ? withBase(path) : '';
    }

    function leagueIcon(leagueName) {
        if (!leagueName) return '';
        const k = String(leagueName).trim();
        const lookup = k.charAt(0).toUpperCase() + k.slice(1).toLowerCase();
        return LEAGUES[lookup] ? withBase(LEAGUES[lookup]) : '';
    }

    function resultIcon(resultName) {
        return RESULTS[resultName] ? withBase(RESULTS[resultName]) : '';
    }

    function miscIcon(key) {
        return MISC[key] ? withBase(MISC[key]) : '';
    }

    function strategyIcons(strategyName, max = 3) {
        if (!strategyName) return [];
        // 1. Explicit table.
        if (STRATEGIES[strategyName]) {
            return STRATEGIES[strategyName].slice(0, max).map(withBase);
        }
        // 2. Keyword fallback. Walk in order, stop at `max`.
        const lower = String(strategyName).toLowerCase();
        const seen = new Set();
        const picked = [];
        // Keyword list is ordered building -> unit -> upgrade; we
        // preserve that bias so a "Stargate Phoenix" search yields
        // the building first then the unit.
        for (const entry of KEYWORDS) {
            if (lower.indexOf(entry.kw) === -1) continue;
            if (seen.has(entry.icon)) continue;
            seen.add(entry.icon);
            picked.push(withBase(entry.icon));
            if (picked.length >= max) break;
        }
        return picked;
    }

    // Helper: build an <img> element with onerror fallback so a
    // missing icon hides itself instead of showing a broken-image
    // placeholder. Returns the element ready to be appended.
    function makeIconImg(url, altText) {
        if (!url) return null;
        const img = document.createElement('img');
        img.className = 'sc2-icon';
        img.src = url;
        img.alt = altText || '';
        img.title = altText || '';
        img.draggable = false;
        img.onerror = function () {
            // Hide the broken icon -- the surrounding text takes over.
            img.style.display = 'none';
        };
        return img;
    }

    // Populate a container element with icons for a list of urls.
    // Existing children are replaced. No-op if container is null.
    function fillIconRow(containerEl, urls, altText) {
        if (!containerEl) return;
        containerEl.innerHTML = '';
        for (const u of urls || []) {
            const img = makeIconImg(u, altText);
            if (img) containerEl.appendChild(img);
        }
    }

    window.SC2Icons = {
        raceIcon, leagueIcon, resultIcon, miscIcon,
        strategyIcons, makeIconImg, fillIconRow,
        BASE
    };
})();
