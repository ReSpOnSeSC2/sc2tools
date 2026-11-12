#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const web = fileURLToPath(new URL("..", import.meta.url));

async function referenceBuilder() {
  const folder = await mkdtemp(join(tmpdir(), "sc2-pace-reference-"));
  try {
    execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "lib/instant/paceReference.ts",
      "--strict", "--skipLibCheck", "--module", "commonjs", "--target", "es2022", "--outDir", folder],
    { cwd: web, stdio: "inherit" });
    return require(join(folder, "paceReference.js")).buildPaceReference;
  } finally {
    for (const file of ["paceReference.js", "paceCurves.js"]) {
      await unlink(join(folder, file)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await rmdir(folder);
  }
}

async function writeReference(path, reference) {
  const output = resolve(path);
  const pending = output + "." + randomUUID() + ".tmp";
  try {
    await writeFile(pending, JSON.stringify(reference, null, 2) + "\n", { flag: "wx" });
    await rename(pending, output);
  } finally {
    await unlink(pending).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function main() {
  const { values } = parseArgs({ options: { source: { type: "string" }, out: { type: "string" } } });
  if (!values.source || !values.out || resolve(values.source) === resolve(values.out)) {
    throw new Error("Usage: node scripts/build-pace-reference.mjs --source local-games.json --out reference.json");
  }
  const source = JSON.parse(await readFile(values.source, "utf8"));
  const build = await referenceBuilder();
  const reference = build(source);
  if (reference.buckets.length === 0) throw new Error("No matchup and patch-era cohort met the reference floors.");
  await writeReference(values.out, reference);
  console.log(`Wrote ${reference.buckets.length} pace reference cohort(s).`);
}

main().catch((error) => {
  // A JSON parse error can include part of a private input row.
  console.error(error instanceof SyntaxError ? "The input is not valid JSON." : error.message);
  process.exitCode = 1;
});
