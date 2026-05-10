"use strict";

/**
 * Read-only diagnostic — find probable duplicate game rows that share the
 * same physical replay but landed under different ``gameId`` values.
 *
 * Background
 * ----------
 * Game rows are deduped by the unique index ``{userId, gameId}``. The
 * agent constructs ``gameId`` in
 * ``SC2Replay-Analyzer/core/replay_loader.py`` as
 *
 *   f"{date_str}|{opponent.name}|{replay.map_name or 'unknown'}|{length_sec}"
 *
 * which is NOT a content hash. If any of the four components round-trips
 * differently across parses (sc2reader version drift, datetime
 * naive-vs-aware, localised map names, frame-rate-derived duration), the
 * same replay file produces a fresh ``gameId`` on re-upload, slips past
 * the unique index, AND triggers ``OpponentsService.recordGame``'s
 * ``$inc`` on ``gameCount`` / ``wins`` / ``losses`` — inflating opponent
 * counters proportionally to the number of times the replay re-ingested.
 *
 * Heuristic
 * ---------
 * Two rows with the same ``(userId, opponent.pulseId, date, durationSec,
 * map)`` but different ``gameId`` are almost certainly the same physical
 * replay parsed twice. The exact-to-the-second timestamp makes
 * legitimate-but-coincidental collisions vanishingly rare (a rematch
 * against the same opponent on the same map for the same exact duration
 * would still differ in ``date`` by at least one second).
 *
 * Output
 * ------
 *   1. Per-user totals: ``rows`` vs ``logical`` (distinct cluster keys)
 *      — the inflation factor.
 *   2. The top opponents within each suspect user, by raw ``rows``,
 *      so we can confirm the suspect user matches the screenshot
 *      (1486-25 vs CoffeeTime, etc.).
 *   3. A small sample of duplicate clusters with their ``gameId``
 *      values side-by-side — useful for spotting which component
 *      drifted (the date, the map name, the duration).
 *
 * No writes. No ``recordGame``. No ``opponents`` mutation. Safe to run
 * against production.
 *
 * Usage
 * -----
 *   MONGODB_URI=... MONGODB_DB=sc2tools_saas \
 *     node apps/api/scripts/audit-duplicate-games.js [--user-id <userId>] \
 *       [--top-users <N>] [--top-opps <N>] [--samples <N>]
 *
 * Flags:
 *   --user-id   Audit a single user (skip the per-user scan).
 *   --top-users Show the N most-inflated users (default 10).
 *   --top-opps  Per user, show the top N opponents by raw row count
 *               (default 5 — matches the SPA's "Top opponents" widget).
 *   --samples   Per suspect user, print N example duplicate clusters
 *               (default 5).
 */

const path = require("path");
const { MongoClient } = require("mongodb");

const { COLLECTIONS } = require(
  path.join(__dirname, "..", "src", "config", "constants"),
);

function parseArgs(argv) {
  /** @type {Record<string, string|number|undefined>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--user-id") out.userId = String(argv[i + 1] || "");
    else if (a === "--top-users") out.topUsers = Number(argv[i + 1] || 10);
    else if (a === "--top-opps") out.topOpps = Number(argv[i + 1] || 5);
    else if (a === "--samples") out.samples = Number(argv[i + 1] || 5);
  }
  if (typeof out.topUsers !== "number" || !Number.isFinite(out.topUsers)) {
    out.topUsers = 10;
  }
  if (typeof out.topOpps !== "number" || !Number.isFinite(out.topOpps)) {
    out.topOpps = 5;
  }
  if (typeof out.samples !== "number" || !Number.isFinite(out.samples)) {
    out.samples = 5;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || "sc2tools_saas";
  if (!uri) {
    console.error("MONGODB_URI required");
    process.exit(2);
  }
  const client = new MongoClient(uri, { retryWrites: true });
  await client.connect();
  try {
    const games = client.db(dbName).collection(COLLECTIONS.GAMES);
    if (args.userId) {
      await auditUser(games, String(args.userId), args);
    } else {
      await auditAll(games, args);
    }
  } finally {
    await client.close();
  }
}

/**
 * Per-user duplicate clustering. Group by the heuristic key, count rows
 * per cluster, surface clusters with ``count > 1``.
 *
 * Each row in the result represents one logical replay; ``count`` is
 * how many times it landed under distinct ``gameId`` values.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 */
async function clusterDuplicates(games, userId) {
  return games
    .aggregate([
      { $match: { userId } },
      {
        $group: {
          _id: {
            pulseId: "$opponent.pulseId",
            date: "$date",
            durationSec: "$durationSec",
            map: "$map",
          },
          count: { $sum: 1 },
          gameIds: { $addToSet: "$gameId" },
          result: { $first: "$result" },
          oppName: { $first: "$opponent.displayName" },
          oppRace: { $first: "$opponent.race" },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
}

/**
 * Per-user totals: raw row count vs distinct logical-replay count.
 * ``inflation`` = rows / logical. 1.0 = clean, > 1.0 = duplicates exist.
 *
 * @param {import('mongodb').Collection} games
 */
async function userInflation(games) {
  return games
    .aggregate([
      {
        $match: {
          "opponent.pulseId": { $type: "string", $ne: "" },
          date: { $type: "date" },
        },
      },
      {
        $group: {
          _id: {
            userId: "$userId",
            pulseId: "$opponent.pulseId",
            date: "$date",
            durationSec: "$durationSec",
            map: "$map",
          },
          rows: { $sum: 1 },
        },
      },
      {
        $group: {
          _id: "$_id.userId",
          rows: { $sum: "$rows" },
          logical: { $sum: 1 },
          dupClusters: {
            $sum: { $cond: [{ $gt: ["$rows", 1] }, 1, 0] },
          },
        },
      },
      {
        $project: {
          _id: 0,
          userId: "$_id",
          rows: 1,
          logical: 1,
          dupClusters: 1,
          inflation: {
            $cond: [
              { $gt: ["$logical", 0] },
              { $divide: ["$rows", "$logical"] },
              1,
            ],
          },
        },
      },
      { $match: { dupClusters: { $gt: 0 } } },
      { $sort: { inflation: -1, rows: -1 } },
    ])
    .toArray();
}

/**
 * Top-N opponents for a single user by raw row count — i.e. the same
 * "top by gameCount" view the admin user-detail page renders. Returned
 * with both the raw row count AND a per-opponent logical count so the
 * caller can show the inflation factor.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {number} limit
 */
async function topOpponentsByRows(games, userId, limit) {
  const topRaw = await games
    .aggregate([
      { $match: { userId, "opponent.pulseId": { $type: "string", $ne: "" } } },
      {
        $group: {
          _id: "$opponent.pulseId",
          rows: { $sum: 1 },
          wins: {
            $sum: {
              $cond: [
                { $in: [{ $toLower: { $ifNull: ["$result", ""] } }, ["victory", "win"]] },
                1,
                0,
              ],
            },
          },
          losses: {
            $sum: {
              $cond: [
                { $in: [{ $toLower: { $ifNull: ["$result", ""] } }, ["defeat", "loss"]] },
                1,
                0,
              ],
            },
          },
          oppName: { $last: "$opponent.displayName" },
          oppRace: { $last: "$opponent.race" },
        },
      },
      { $sort: { rows: -1 } },
      { $limit: limit },
    ])
    .toArray();
  // Per-opponent logical count via a grouped aggregation. One round
  // trip per top-N row keeps the script simple; the dataset is bounded
  // by ``limit`` so the cost is constant regardless of user size.
  for (const r of topRaw) {
    const logical = await games
      .aggregate([
        { $match: { userId, "opponent.pulseId": r._id } },
        {
          $group: {
            _id: { date: "$date", durationSec: "$durationSec", map: "$map" },
          },
        },
        { $count: "n" },
      ])
      .toArray();
    r.logical = logical[0] ? logical[0].n : r.rows;
    r.factor = r.rows / Math.max(1, r.logical);
  }
  return topRaw;
}

/**
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {{ topOpps: number, samples: number }} args
 */
async function auditUser(games, userId, args) {
  console.log(`\n=== userId=${userId} ===`);
  const totalRows = await games.countDocuments({ userId });
  console.log(`games rows total: ${totalRows}`);

  const clusters = await clusterDuplicates(games, userId);
  if (clusters.length === 0) {
    console.log("no duplicate clusters detected — gameIds are distinct per logical replay");
    return;
  }
  const dupRows = clusters.reduce((acc, c) => acc + c.count, 0);
  const dupExtra = dupRows - clusters.length;
  console.log(
    `duplicate clusters: ${clusters.length}  affecting rows: ${dupRows}  redundant rows: ${dupExtra}`,
  );
  console.log(
    `inflation: ${(totalRows / Math.max(1, totalRows - dupExtra)).toFixed(3)}x  `
    + `(true logical games ≈ ${totalRows - dupExtra})`,
  );

  const topRaw = await topOpponentsByRows(games, userId, args.topOpps);
  console.log(`\ntop ${args.topOpps} opponents by raw rows:`);
  for (const r of topRaw) {
    console.log(
      `  ${r.oppName || "?"} (${r.oppRace || "?"}) ${r._id}  `
      + `rows=${r.rows}  logical=${r.logical}  inflation=${r.factor.toFixed(2)}x  `
      + `W-L=${r.wins}-${r.losses}`,
    );
  }

  // Sample clusters so we can eyeball which gameId component drifted.
  // Print ``gameIds`` side-by-side so the diff between them tells us
  // which of {date, opponent name, map name, length} varied.
  console.log(`\nsample duplicate clusters (up to ${args.samples}):`);
  for (const c of clusters.slice(0, args.samples)) {
    const dateStr = c._id.date && c._id.date.toISOString
      ? c._id.date.toISOString()
      : c._id.date;
    console.log(
      `  count=${c.count}  ${dateStr}  ${c.oppName || "?"} (${c.oppRace || "?"})  `
      + `map="${c._id.map || "?"}"  durationSec=${c._id.durationSec}`,
    );
    for (const gid of c.gameIds) {
      console.log(`    gameId: ${JSON.stringify(gid)}`);
    }
  }
}

/**
 * @param {import('mongodb').Collection} games
 * @param {{ topUsers: number, topOpps: number, samples: number }} args
 */
async function auditAll(games, args) {
  console.log("scanning all users for duplicate game rows...");
  const inflation = await userInflation(games);
  if (inflation.length === 0) {
    console.log(
      "no users with duplicate clusters — gameId construction is round-tripping cleanly",
    );
    return;
  }
  console.log(
    `${inflation.length} users have duplicate clusters. top ${args.topUsers} by inflation:\n`,
  );
  console.log(
    "rank  inflation   rows  logical  dupClusters  userId",
  );
  const top = inflation.slice(0, args.topUsers);
  top.forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(4)}  ${r.inflation.toFixed(3)}x  `
      + `${String(r.rows).padStart(6)}  ${String(r.logical).padStart(7)}  `
      + `${String(r.dupClusters).padStart(11)}  ${r.userId}`,
    );
  });

  console.log(
    `\ndrilling into the top ${Math.min(top.length, 3)} users for sample clusters:`,
  );
  for (const r of top.slice(0, 3)) {
    await auditUser(games, r.userId, args);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { clusterDuplicates, userInflation };
