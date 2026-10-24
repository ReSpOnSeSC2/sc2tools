"use strict";

/**
 * @param {import('./buildIntentOptions').BuildIntentOptions} options
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
