"use strict";

/**
 * Proxy evidence — turns the agent's ``spatial.{my,opp}_proxies`` list and
 * its ``{my,opp}_proxy_classification_v`` stamp into the rows
 * ``parseBuildLogLines`` correlates onto build-log events.
 *
 * The canonical proxy test (apps/replay-engine/core/build_definitions.py,
 * ``proxy_distance_for``): a structure is proxied when it stands farther
 * from its owner's main (their first town hall) than its radius — 80 world
 * units for town halls, gas and Spine / Spore Crawlers, 50 for everything
 * else. A standard third base sits 50-80 units out on most ladder maps, so
 * the flat 50 units the first stamp used made "proxied Hatchery before
 * 4:00" match ordinary three-base games.
 *
 * Stamp versions:
 *   - 2: the canonical test. Rows are trusted as they are.
 *   - 1 (agent 0.16.0 on): every structure tested at 50 units. Nothing the
 *     agent left out becomes a proxy under the wider radius, and a
 *     50-unit structure keeps its verdict, so only the listed wide-radius
 *     rows need a second look. For the user's own side the main is in
 *     ``spatial.buildings`` and the row is re-tested here; for the
 *     opponent's side (no building list is stored) the row is marked
 *     ``ambiguous`` and the rule evaluator reports a proxy rule that
 *     depends on it as unavailable instead of guessing.
 *   - absent: the side was never classified (``known: false``).
 *
 * Keep the radii and the wide-radius set identical to build_definitions.py;
 * __tests__/customRuleParity.test.js checks both against the fixture the
 * engine's own suite reads.
 */

const PROXY_CLASSIFICATION_VERSION = 2;
const PROXY_DISTANCE_DEFAULT = 50;
const PROXY_DISTANCE_EXPANSION = 80;

/** Structures a macro game places at its third base and beyond. */
const EXPANSION_PROXY_BUILDING_NAMES = new Set([
  "Nexus", "CommandCenter", "Hatchery",
  // Morphed town halls cannot carry a proxy rule; listed to match the engine.
  "OrbitalCommand", "PlanetaryFortress", "Lair", "Hive",
  "Assimilator", "Refinery", "Extractor",
  "SpineCrawler", "SporeCrawler",
]);

/** Town halls ``BaseStrategyDetector._get_main_base_loc`` considers. */
const TOWN_HALL_NAMES = new Set([
  "Nexus", "Hatchery", "CommandCenter", "OrbitalCommand", "PlanetaryFortress",
]);

/**
 * Example: proxyDistanceFor("Hatchery") === 80; proxyDistanceFor("Barracks") === 50
 * @param {unknown} name
 * @returns {number}
 */
function proxyDistanceFor(name) {
  return typeof name === "string" && EXPANSION_PROXY_BUILDING_NAMES.has(name)
    ? PROXY_DISTANCE_EXPANSION
    : PROXY_DISTANCE_DEFAULT;
}

/** @param {unknown} n @returns {n is number} */
function finite(n) {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * The owner's main from their stored building list: the earliest town hall,
 * the first listed on a tie — the same pick as the engine's
 * ``_get_main_base_loc``. Null when it cannot be established.
 *
 * @param {unknown} buildings ``spatial.buildings``
 * @returns {{x: number, y: number} | null}
 */
function ownerMain(buildings) {
  if (!Array.isArray(buildings)) return null;
  /** @type {{time: number, x: number, y: number} | null} */
  let main = null;
  for (const row of buildings) {
    if (!row || typeof row !== "object" || !TOWN_HALL_NAMES.has(row.name)) {
      continue;
    }
    // The engine sorts every town hall by time, so one it could not have
    // ordered leaves the pick unknown rather than probably-right.
    if (!finite(row.time) || !finite(row.x) || !finite(row.y)) return null;
    if (main === null || row.time < main.time) {
      main = { time: row.time, x: row.x, y: row.y };
    }
  }
  // (0, 0) is the engine's "no main" sentinel; the agent never stamps it.
  if (!main || (main.x === 0 && main.y === 0)) return null;
  return { x: main.x, y: main.y };
}

/**
 * Resolve one side's stored proxy evidence to the canonical test.
 *
 * Example:
 *   const my = proxyEvidence(game.spatial, "my");
 *   parseBuildLogLines(game.buildLog, catalog, my.rows, my.known);
 *
 * @param {Record<string, any> | null | undefined} spatial
 * @param {"my" | "opp"} side
 * @returns {{ rows: unknown, known: boolean }} ``rows`` goes to
 *   ``parseBuildLogLines`` unchanged; a row carrying ``ambiguous: true`` is
 *   one whose verdict a version-1 stamp cannot settle.
 */
function proxyEvidence(spatial, side) {
  if (!spatial) return { rows: undefined, known: false };
  const rows = spatial[`${side}_proxies`];
  const version = spatial[`${side}_proxy_classification_v`];
  if (version === PROXY_CLASSIFICATION_VERSION) return { rows, known: true };
  if (version !== 1) return { rows, known: false };
  if (!Array.isArray(rows)) return { rows, known: true };
  const main = side === "my" ? ownerMain(spatial.buildings) : null;
  const out = [];
  for (const row of rows) {
    const wide = row && typeof row === "object" && typeof row.name === "string"
      && EXPANSION_PROXY_BUILDING_NAMES.has(row.name.trim());
    // Rows without usable geometry are left for annotateProxyBuildings,
    // which fails the whole side closed on them as it always has.
    if (!wide || !finite(row.x) || !finite(row.y)) {
      out.push(row);
      continue;
    }
    if (!main) {
      out.push({ ...row, ambiguous: true });
      continue;
    }
    const dx = row.x - main.x;
    const dy = row.y - main.y;
    if (Math.sqrt(dx * dx + dy * dy) > PROXY_DISTANCE_EXPANSION) out.push(row);
    // else: a third base (or its gas / crawlers), not a proxy.
  }
  return { rows: out, known: true };
}

module.exports = {
  PROXY_CLASSIFICATION_VERSION,
  PROXY_DISTANCE_DEFAULT,
  PROXY_DISTANCE_EXPANSION,
  EXPANSION_PROXY_BUILDING_NAMES,
  ownerMain,
  proxyDistanceFor,
  proxyEvidence,
};
