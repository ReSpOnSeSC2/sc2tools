#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { compileDailyHelpers, utcDate, writeImmutable } from "./daily/buildFiles.mjs";
import { publishIndex, readIndex } from "./daily/packIndex.mjs";

const web = fileURLToPath(new URL("..", import.meta.url));
const engine = join(web, "..", "replay-engine");
const options = { practice: { type: "boolean" }, plan: { type: "string" }, out: { type: "string" }, python: { type: "string" } };
const run = promisify(execFile);

async function publishPack(out, pack, helpers) {
  const body = Buffer.from(JSON.stringify(pack));
  if (!helpers.readScoutPack(pack) || body.length > helpers.MAX_SCOUT_PACK_BYTES) {
    throw new Error("A Scout pack failed the public allowlist or exceeds its size limit.");
  }
  const digest = createHash("sha256").update(body).digest("hex");
  const folder = join(out, "packs", digest);
  await mkdir(folder, { recursive: true });
  await writeImmutable(join(folder, "pack.json"), body);
  return digest;
}

async function readPlan(path, helpers) {
  const plan = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(plan.days) || !plan.days.length || plan.days.length > 366) throw new Error("Provide one to 366 UTC days.");
  const days = new Map();
  for (const value of plan.days) {
    const day = helpers.utcDay(utcDate(value?.day));
    if (days.has(day)) throw new Error("The plan includes the same UTC day twice.");
    if (day <= helpers.utcDay(Date.now())) throw new Error("Schedule Scout sets before the UTC day starts.");
    if (!Array.isArray(value.sources) || value.sources.length !== helpers.DAILY_ROUNDS) {
      throw new Error("Every UTC day needs five consented Tracker sources.");
    }
    days.set(day, value.sources);
  }
  return Array.from(days).sort(([a], [b]) => a - b);
}

function replayArgs(directory, source) {
  if (source?.consented !== true) throw new Error("Each source needs explicit publication consent.");
  if (source.side !== "me" && source.side !== "opp") throw new Error("Provide the selected replay side.");
  if (![source.replay, source.perspective].every(value => typeof value === "string" && value.trim())) {
    throw new Error("Provide a local .SC2Replay and exact player name for detector and Tracker extraction.");
  }
  if (Object.hasOwn(source, "strategy") || Object.hasOwn(source, "labelSource")) {
    throw new Error("Detector labels must come from the replay.");
  }
  return [join(engine, "scripts", "scout_source.py"), "--replay=" + resolve(directory, source.replay),
    "--perspective=" + source.perspective, "--side=" + source.side];
}

async function extractSource(directory, source, python) {
  const args = replayArgs(directory, source);
  let result;
  try {
    const { stdout } = await run(python, args, { cwd: engine, windowsHide: true });
    result = JSON.parse(stdout);
  } catch {
    throw new Error("Could not establish detector and Tracker evidence with the replay-engine Python environment.");
  }
  if (!result || !/^[a-f0-9]{64}$/.test(result.replaySha256) || !Number.isSafeInteger(result.playerSlot)) {
    throw new Error("Could not verify replay content and the selected player slot.");
  }
  return result;
}

async function buildPlannedSets(out, path, index, helpers, python) {
  const unique = new Set();
  for (const [day, sources] of await readPlan(path, helpers)) {
    const puzzles = [];
    for (const source of sources) {
      const raw = await extractSource(dirname(path), source, python);
      const key = raw.replaySha256 + ":" + raw.playerSlot;
      if (unique.has(key)) throw new Error("A replay player slot can only appear once across the plan.");
      unique.add(key);
      puzzles.push(helpers.scoutPuzzleFrom(source, raw));
    }
    index.days[day] = await publishPack(out, { version: 1, puzzles }, helpers);
  }
}

async function build(out, values, helpers) {
  const indexPath = join(out, "index.json");
  const index = await readIndex(indexPath, helpers.readDailyIndex, helpers.readScoutPack);
  const previousDays = { ...index.days };
  if (values.practice) {
    index.practice = [];
    for (const pack of helpers.scoutPracticeWeek()) index.practice.push(await publishPack(out, pack, helpers));
  } else {
    await buildPlannedSets(out, resolve(values.plan), index, helpers, values.python ?? "python");
  }
  if (!helpers.readDailyIndex(index)) throw new Error("Build the seven-day practice set before publishing the Scout index.");
  await publishIndex(indexPath, index, previousDays, helpers.utcDay, { futureOnly: true });
  console.log(`Published ${index.practice.length} practice sets and ${Object.keys(index.days).length} Tracker UTC days.`);
}

async function main() {
  const { values } = parseArgs({ options });
  if (Boolean(values.practice) === Boolean(values.plan)) {
    throw new Error("Usage: node scripts/build-daily-scout.mjs (--practice | --plan plan.json) [--out folder] [--python interpreter]");
  }
  const out = values.out ? resolve(values.out) : join(web, "public", "daily", "scout", "v1");
  const helpers = await compileDailyHelpers(web, ["lib/daily/clip.ts", "lib/daily/scoutPractice.ts", "lib/daily/scoutSource.ts"],
    ["daily/clip", "daily/rules", "daily/scout", "daily/scoutPractice", "daily/scoutSource"]);
  const detectorSources = await Promise.all(helpers.SCOUT_DETECTOR_FILES.map(file => readFile(join(engine, "core", file), "utf8")));
  if (!helpers.detectorLabelsMatch(detectorSources.join("\n"))) throw new Error("Update Scout labels to match the strategy detector.");
  await mkdir(out, { recursive: true });
  const lockPath = join(out, ".build.lock");
  const lock = await open(lockPath, "wx");
  try {
    await build(out, values, helpers);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
