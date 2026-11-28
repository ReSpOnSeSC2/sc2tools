"use strict";

/**
 * @typedef {{ key: string, name: string, source: string }} OfferedBuild
 * @typedef {{ forMatchup(userId: string, matchup: string): Promise<{ builds: OfferedBuild[] }> }} OfferedBuilds
 *   The account's builds per matchup: `BuildIntentOptions` in production.
 */

/**
 * The randomizer config as the overlay widget receives it: in each enabled
 * matchup, every stored pool entry the account still offers takes the
 * build's current name and source and the matchup's race; the rest drop.
 * The desktop card repeats this step (apps/agent build_checkin/randomizer_draw.py),
 * and apps/web/lib/randomizer/__tests__/unitDrawParity.json pins both.
 * @param {OfferedBuilds} options
 * @param {string} userId
 * @param {Record<string, any>} raw
 */
async function overlayRandomizerConfig(options, userId, raw) {
  const matchups = { ...(raw.matchups || {}) };
  await Promise.all(Object.entries(matchups).map(async ([matchup, config]) => {
    if (!/^[PTZ]v[PTZ]$/.test(matchup) || !config || config.enabled !== true) return;
    const available = await options.forMatchup(userId, matchup);
    const byKey = new Map(available.builds.map((build) => [build.key, build]));
    const builds = Array.isArray(config.builds) && config.builds.length <= 500 ? config.builds : [];
    const selected = [];
    for (const build of builds) {
      const canonical = build && byKey.get(build.id);
      if (canonical) selected.push({ ...build, name: canonical.name, source: canonical.source,
        race: matchup[0] === "P" ? "Protoss" : matchup[0] === "T" ? "Terran" : "Zerg" });
    }
    matchups[matchup] = { ...config, builds: selected };
  }));
  return { ...raw, matchups };
}

module.exports = { overlayRandomizerConfig };
