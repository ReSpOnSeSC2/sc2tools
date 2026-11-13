import { mkdtemp, readFile, readdir, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { publishIndex } from "../../../scripts/daily/packIndex.mjs";
import { utcDay } from "../rules";

test("pins started UTC days and atomically promotes only compatible changes", async () => {
  const now = Date.parse("2026-11-12T00:00:00Z");
  const clock = vi.spyOn(Date, "now").mockReturnValue(now - 1);
  const day = utcDay(now);
  const folder = await mkdtemp(join(tmpdir(), "sc2-daily-index-test-"));
  const path = join(folder, "index.json");
  const current = { [day - 2]: "a".repeat(64), [day]: "b".repeat(64), [day + 1]: "c".repeat(64) };
  const index = (days: Record<string, string>) => ({ version: 1, days, practice: [] });
  try {
    await publishIndex(path, index(current), {}, utcDay);
    const adjusted = { ...current, [day]: "d".repeat(64) };
    await publishIndex(path, index(adjusted), current, utcDay);
    const before = await readFile(path, "utf8");

    clock.mockReturnValue(now);
    await expect(publishIndex(path, index(current), adjusted, utcDay)).rejects.toThrow("must keep its published pack");
    const { [day - 2]: missing, ...withoutPast } = adjusted;
    expect(missing).toBeDefined();
    await expect(publishIndex(path, index(withoutPast), adjusted, utcDay)).rejects.toThrow("must keep its published pack");
    const newlyStarted = { ...adjusted, [day - 1]: "a".repeat(64) };
    await expect(publishIndex(path, index(newlyStarted), adjusted, utcDay, { futureOnly: true })).rejects.toThrow("started while building");
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await readdir(folder)).toEqual(["index.json"]);

    const future = { ...adjusted, [day + 1]: "e".repeat(64) };
    await publishIndex(path, index(future), adjusted, utcDay, { futureOnly: true });
    await publishIndex(path, index(future), future, utcDay);
    expect(JSON.parse(await readFile(path, "utf8")).days).toEqual(future);
  } finally {
    clock.mockRestore();
    await rm(path, { force: true });
    await rmdir(folder);
  }
});
