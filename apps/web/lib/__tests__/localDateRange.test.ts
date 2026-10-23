// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { localDayStartIso, localNextDayStartIso } from "../localDateRange";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
afterEach(() => vi.unstubAllEnvs());
it("includes both calendar days in the player's local timezone", () => {
  vi.stubEnv("TZ", "America/Los_Angeles");
  expect(localDayStartIso("2025-10-01")).toBe(new Date(2025, 9, 1).toISOString());
  expect(localNextDayStartIso("2025-10-15")).toBe(new Date(2025, 9, 16).toISOString());
  // Node's Windows worker may inherit the host zone; the calendar semantics stay local.
  expect(new Date(localNextDayStartIso("2025-10-15")).getDate()).toBe(16);
  expect(() => localDayStartIso("2025-02-30")).toThrow("Invalid calendar date");
});
it("uses Los Angeles midnight boundaries, including the complete Through day", () => {
  const source = ts.transpile(readFileSync("lib/localDateRange.ts", "utf8"), { module: ts.ModuleKind.CommonJS });
  const output = execFileSync(process.execPath, ["-e", source + ';console.log(JSON.stringify([exports.localDayStartIso("2025-10-01"),exports.localNextDayStartIso("2025-10-15")]));'], { env: { ...process.env, TZ: "America/Los_Angeles" }, encoding: "utf8" });
  expect(JSON.parse(output)).toEqual(["2025-10-01T07:00:00.000Z", "2025-10-16T07:00:00.000Z"]);
});
