import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

export async function readIndex(path, parseIndex) {
  try {
    const index = parseIndex(JSON.parse(await readFile(path, "utf8")));
    if (!index) throw new Error("Existing Daily index is invalid.");
    return index;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { version: 1, days: {}, practice: [] };
  }
}

export async function publishIndex(path, index, previousDays, utcDay, { futureOnly = false } = {}) {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(index, null, 2) + "\n", { flag: "wx" });
    // Evaluate the UTC cutoff at promotion. Building a pack can run across midnight.
    const today = utcDay(Date.now());
    for (const [day, digest] of Object.entries(previousDays)) {
      if (Number(day) <= today && index.days[day] !== digest) {
        throw new Error("A recorded UTC day that has started must keep its published pack.");
      }
    }
    if (futureOnly && Object.keys(index.days).some(day => Number(day) <= today && !Object.hasOwn(previousDays, day))) {
      throw new Error("The scheduled UTC day started while building the pack.");
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
