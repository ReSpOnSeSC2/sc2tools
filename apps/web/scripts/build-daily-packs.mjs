#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { publishIndex, readIndex } from "./daily/packIndex.mjs";
import { recordingFights, resolveRecording } from "./daily/recordings.mjs";
import { compileDailyHelpers, utcDate, writeImmutable } from "./daily/buildFiles.mjs";

const web = fileURLToPath(new URL("..", import.meta.url));
const options = {
  practice: { type: "boolean" },
  plan: { type: "string" },
  out: { type: "string" },
};

async function readPlan(path, helpers) {
  const plan = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(plan.days) || !plan.days.length || plan.days.length > 366) throw new Error("Provide one to 366 days in the plan.");
  const seen = new Set();
  return plan.days.map(value => {
    const day = helpers.utcDay(utcDate(value?.day));
    if (seen.has(day)) throw new Error("The plan includes the same UTC day twice.");
    seen.add(day);
    if (!Array.isArray(value.sources) || !value.sources.length) throw new Error("Every UTC day needs a source list.");
    return { day, sources: value.sources.map(source => resolveRecording(dirname(path), source)) };
  }).sort((a, b) => a.day - b.day);
}

async function publishPack(out, pack, terrain, helpers) {
  if (!helpers.readDailyPack(pack)) throw new Error("A pack failed the public allow-list or exceeded clip limits.");
  const body = Buffer.from(JSON.stringify(pack));
  if (body.length > helpers.MAX_PACK_BYTES) throw new Error("A Daily pack exceeds its size limit.");
  const content = createHash("sha256").update(body);
  terrain.forEach((image, index) => {
    if (image) content.update(String(index) + ":" + image.length + ":").update(image);
  });
  const digest = content.digest("hex");
  const folder = join(out, "packs", digest);
  await mkdir(folder, { recursive: true });
  await writeImmutable(join(folder, "pack.json"), body);
  for (const [index, image] of terrain.entries()) {
    if (image) await writeImmutable(join(folder, String(index + 1) + ".webp"), image);
  }
  return digest;
}

async function collectDay(sources, used, helpers) {
  const fights = [], terrain = [];
  for (const source of sources) {
    for await (const draft of recordingFights(source, helpers)) {
      if (used.has(draft.key)) continue;
      used.add(draft.key);
      fights.push(draft.fight);
      terrain.push(await draft.terrain());
      if (fights.length === helpers.FIGHTS_PER_DAY) return { fights, terrain };
    }
  }
  throw new Error("Fewer than five qualifying fights. Add more consented recordings to this UTC day.");
}

async function build(values, out, helpers) {
  const indexPath = join(out, "index.json");
  const index = await readIndex(indexPath, helpers.readDailyIndex);
  const previousDays = { ...index.days };
  if (values.practice) {
    index.practice = [];
    for (const pack of helpers.fixtureWeek()) index.practice.push(await publishPack(out, pack, [], helpers));
  }
  if (values.plan) {
    const used = new Set();
    const days = await readPlan(resolve(values.plan), helpers);
    for (const { day, sources } of days) {
      const { fights, terrain } = await collectDay(sources, used, helpers);
      index.days[day] = await publishPack(out, { version: 1, fights }, terrain, helpers);
    }
  }
  if (!helpers.readDailyIndex(index)) throw new Error("Build the seven-day practice set before publishing the Daily index.");
  await publishIndex(indexPath, index, previousDays, helpers.utcDay);
  console.log("Published " + index.practice.length + " practice sets and " + Object.keys(index.days).length + " recorded UTC days.");
}

async function main() {
  const { values } = parseArgs({ options });
  if (Boolean(values.practice) === Boolean(values.plan)) {
    throw new Error("Usage: node scripts/build-daily-packs.mjs (--practice | --plan plan.json) [--out folder]");
  }
  const out = values.out ? resolve(values.out) : join(web, "public", "daily", "v1");
  const helpers = await compileDailyHelpers(web, ["lib/daily/fixtureWeek.ts", "lib/segmentedPlayback.ts"],
    ["daily/buildPack", "daily/clip", "daily/fixtureWeek", "daily/rules", "segmentedPlayback"]);
  await mkdir(out, { recursive: true });
  const lockPath = join(out, ".build.lock");
  const lock = await open(lockPath, "wx");
  try {
    await build(values, out, helpers);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
