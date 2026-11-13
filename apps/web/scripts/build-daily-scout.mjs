#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compileDailyHelpers, utcDate, writeImmutable } from "./daily/buildFiles.mjs";
import { publishIndex, readIndex } from "./daily/packIndex.mjs";

const web = fileURLToPath(new URL("..", import.meta.url));
const detectorRoot = join(web, "..", "replay-engine", "core");
const options = { practice: { type: "boolean" }, plan: { type: "string" }, out: { type: "string" } };

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

async function buildPlannedSets(out, path, index, helpers) {
  const unique = new Set();
  for (const [day, sources] of await readPlan(path, helpers)) {
    const puzzles = [];
    for (const source of sources) {
      if (typeof source?.file !== "string" || !source.file) throw new Error("Each source needs a local compact Tracker JSON file.");
      const raw = JSON.parse(await readFile(resolve(dirname(path), source.file), "utf8"));
      const puzzle = helpers.scoutPuzzleFrom(source, raw);
      const clues = JSON.stringify(puzzle.buildings);
      if (unique.has(clues)) throw new Error("Provide distinct building clips across the plan.");
      unique.add(clues);
      puzzles.push(puzzle);
    }
    index.days[day] = await publishPack(out, { version: 1, puzzles }, helpers);
  }
}

async function build(out, values, helpers) {
  const indexPath = join(out, "index.json");
  const index = await readIndex(indexPath, helpers.readDailyIndex);
  const previousDays = { ...index.days };
  if (values.practice) {
    index.practice = [];
    for (const pack of helpers.scoutPracticeWeek()) index.practice.push(await publishPack(out, pack, helpers));
  } else {
    await buildPlannedSets(out, resolve(values.plan), index, helpers);
  }
  if (!helpers.readDailyIndex(index)) throw new Error("Build the seven-day practice set before publishing the Scout index.");
  await publishIndex(indexPath, index, previousDays, helpers.utcDay, { futureOnly: true });
  console.log(`Published ${index.practice.length} practice sets and ${Object.keys(index.days).length} Tracker UTC days.`);
}

async function main() {
  const { values } = parseArgs({ options });
  if (Boolean(values.practice) === Boolean(values.plan)) {
    throw new Error("Usage: node scripts/build-daily-scout.mjs (--practice | --plan plan.json) [--out folder]");
  }
  const out = values.out ? resolve(values.out) : join(web, "public", "daily", "scout", "v1");
  const helpers = await compileDailyHelpers(web, ["lib/daily/clip.ts", "lib/daily/scoutPractice.ts", "lib/daily/scoutSource.ts"],
    ["daily/clip", "daily/rules", "daily/scout", "daily/scoutPractice", "daily/scoutSource"]);
  const detectorSources = await Promise.all(helpers.SCOUT_DETECTOR_FILES.map(file => readFile(join(detectorRoot, file), "utf8")));
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
