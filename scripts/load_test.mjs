#!/usr/bin/env node
/**
 * Synthetic load test for the cloud API.
 *
 * Spawns N concurrent virtual agents, each posting a stream of
 * upserts to /v1/games. Reports p50/p95/p99 latency and total error
 * count. The goal is the K-bucket "50 concurrent agents" target.
 *
 *   API_BASE=https://api.sc2tools.app \
 *   LOAD_TEST_TOKEN=<a device token from a real account> \
 *   node scripts/load_test.mjs --agents 50 --games-per-agent 20
 *
 * Use a STAGING database, not prod. The script POSTs real game records;
 * they'll persist as if a real agent uploaded them.
 *
 * Exits with a non-zero code if p95 > 1000ms or any request 5xx'd.
 */

const args = parseArgs(process.argv.slice(2));
const API_BASE = process.env.API_BASE || "http://localhost:8080";
const TOKEN = process.env.LOAD_TEST_TOKEN;
if (!TOKEN) {
  console.error("LOAD_TEST_TOKEN env var required");
  process.exit(1);
}

const N_AGENTS = Number(args.agents || 50);
const GAMES_PER_AGENT = Number(args["games-per-agent"] || 20);
const TARGET_P95_MS = 1000;

console.log(
  `Spinning ${N_AGENTS} agents × ${GAMES_PER_AGENT} games = ${
    N_AGENTS * GAMES_PER_AGENT
  } total POSTs against ${API_BASE}`,
);

const latencies = [];
let errors = 0;

const start = performance.now();

await Promise.all(
  Array.from({ length: N_AGENTS }, (_, agentIdx) =>
    runAgent(agentIdx),
  ),
);

const totalSec = ((performance.now() - start) / 1000).toFixed(2);
latencies.sort((a, b) => a - b);
const p50 = pct(latencies, 0.5);
const p95 = pct(latencies, 0.95);
const p99 = pct(latencies, 0.99);

console.log("\n=== load test report ===");
console.log(`total duration: ${totalSec}s`);
console.log(`requests:       ${latencies.length}`);
console.log(`errors:         ${errors}`);
console.log(`p50:            ${p50.toFixed(0)}ms`);
console.log(`p95:            ${p95.toFixed(0)}ms`);
console.log(`p99:            ${p99.toFixed(0)}ms`);

if (errors > 0) {
  console.error("FAIL: at least one request errored");
  process.exit(1);
}
if (p95 > TARGET_P95_MS) {
  console.error(`FAIL: p95 ${p95}ms exceeds target ${TARGET_P95_MS}ms`);
  process.exit(1);
}
console.log("PASS");

async function runAgent(agentIdx) {
  for (let i = 0; i < GAMES_PER_AGENT; i++) {
    const t0 = performance.now();
    try {
      const res = await fetch(`${API_BASE}/v1/games`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(syntheticGame(agentIdx, i)),
      });
      if (!res.ok) {
        errors += 1;
        console.warn(`agent ${agentIdx} game ${i}: HTTP ${res.status}`);
      }
    } catch (err) {
      errors += 1;
      console.warn(`agent ${agentIdx} game ${i}:`, err);
    }
    latencies.push(performance.now() - t0);
  }
}

function syntheticGame(agentIdx, i) {
  const id = `loadtest-${process.pid}-${agentIdx}-${i}`;
  const dt = new Date(Date.now() - i * 60_000).toISOString();
  return {
    gameId: id,
    date: dt,
    result: i % 2 === 0 ? "Victory" : "Defeat",
    myRace: "Protoss",
    map: "Inside and Out LE",
    durationSec: 600 + (i * 7) % 300,
    macroScore: 70 + (i % 25),
    apm: 150 + (i % 80),
    spq: 250 + (i % 200),
    opponent: {
      pulseId: `1-S2-2-${1_000_000 + agentIdx}`,
      displayName: `LoadOpponent${agentIdx}`,
      race: ["Terran", "Zerg", "Protoss", "Random"][i % 4],
      mmr: 3000 + (i % 1000),
      strategy: "Macro Transition",
    },
    buildLog: [],
    earlyBuildLog: [],
  };
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      out[k] = v;
    }
  }
  return out;
}
