import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);

export async function compileDailyHelpers(web, entries, modules) {
  const tempRoot = resolve(tmpdir());
  const prefix = "sc2-daily-build-";
  const folder = await mkdtemp(join(tempRoot, prefix));
  try {
    execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"),
      ...entries, "--strict", "--skipLibCheck", "--module", "commonjs",
      "--target", "es2022", "--esModuleInterop", "--resolveJsonModule", "--outDir", folder],
    { cwd: web, stdio: "inherit" });
    const compiled = createRequire(join(folder, "loader.cjs"));
    return Object.assign({}, ...modules.map(module => compiled("./" + module + ".js")));
  } finally {
    if (dirname(folder) === tempRoot && basename(folder).startsWith(prefix)) {
      await rm(folder, { recursive: true, force: true });
    }
  }
}

export function utcDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Use a UTC day in YYYY-MM-DD form.");
  const instant = Date.parse(value + "T00:00:00Z");
  if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== value) throw new Error("Invalid UTC day.");
  return instant;
}

export async function writeImmutable(path, bytes) {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await link(temporary, path);
  } catch (error) {
    if (error.code !== "EEXIST" || !(await readFile(path)).equals(bytes)) throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}
