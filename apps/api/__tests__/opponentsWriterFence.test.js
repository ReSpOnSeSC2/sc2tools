// @ts-nocheck
"use strict";
// Every in-process write to the opponents collection runs inside the owner's UserRevision fence, so the write retires
// that owner's retained opponent-MMR bodies (ADR 0072, G1). The scan is lexical over apps/api/src and tolerates a call
// split across lines; the inventory is exact, so a new writer fails here until it is fenced, counted and reviewed.
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const WRITE = /\bopponents\s*\.\s*(?:updateOne|updateMany|insertOne|insertMany|bulkWrite|deleteOne|deleteMany|findOneAndUpdate|findOneAndDelete|findOneAndReplace|replaceOne)\s*\(/g;
const FENCE = "gameWrite(this.userRevision, userId, () => this.db.opponents.";
const files = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? files(path.join(dir, entry.name)) : entry.name.endsWith(".js") ? [path.join(dir, entry.name)] : []);
const sources = files(SRC).map(file => ({ file: path.relative(SRC, file).replaceAll("\\", "/"), text: fs.readFileSync(file, "utf8") }));
const sites = sources.flatMap(({ file, text }) => [...text.matchAll(WRITE)].map(match => {
  const line = text.slice(0, match.index).split("\n").length;
  return { file, line, text: text.split("\n")[line - 1].trim() };
}));
const count = list => list.reduce((counts, site) => ({ ...counts, [site.file]: (counts[site.file] || 0) + 1 }), {});

test("every in-process opponents write carries the owner's fence, and the inventory is exact", () => {
  const inProcess = sites.filter(site => !site.file.startsWith("db/migrations/"));
  expect(inProcess.filter(site => !site.text.includes(FENCE))).toEqual([]);
  expect(count(inProcess)).toEqual({ "services/gdpr.js": 4, "services/opponents.js": 9 });
});

test("the only other writer is the out-of-band migration, and the one collection alias only reads", () => {
  expect(Object.keys(count(sites.filter(site => site.file.startsWith("db/migrations/")))))
    .toEqual(["db/migrations/2026-05-12-heal-opponent-current-name.js"]);
  const aliases = sources.filter(({ file, text }) => !file.startsWith("db/") && /=\s*[\w.]*\bdb\.opponents\s*;/.test(text)).map(({ file }) => file);
  expect(aliases).toEqual(["jobs/pulseBackfillJob.js"]);
  const job = sources.find(({ file }) => file === "jobs/pulseBackfillJob.js").text;
  // The collection variable, not the injected service (`deps.opponents.backfill...`).
  expect([...job.matchAll(/(?<![\w.])opponents\s*\.\s*(\w+)\s*\(/g)].map(match => match[1])).toEqual(["aggregate", "aggregate"]);
});
