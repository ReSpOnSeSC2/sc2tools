import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCommanderProfile, commanderEdge, commanderPace, commanderRepertoire } from "../commanderProfile";
import { commanderCode, commanderName, commanderNameFromCode, type CommanderCategories } from "../commanderTaxonomy";
import type { CommanderRow } from "../commanderEvidence";
import golden from "./fixtures/commanderGolden.generated.json";
import vocabulary from "../commanderTaxonomy.v1.json";

describe("Commander ID population-free parity", () => {
  it("preserves the public card vocabulary and its numeric order", () => {
    expect(createHash("sha256").update(JSON.stringify(vocabulary)).digest("hex")).toBe(
      "9809ea6261a5a4049cad1dfa174a598d00a8b0ae1628e2758410a755f1008012",
    );
  });
  it("matches every full and partial API fallback name with a unique complete code", () => {
    const complete = new Set<number>();
    for (const { categories, name, complete: rated } of golden.combinations) {
      const [a, b, c] = categories;
      const tuple: CommanderCategories = [a, b, c];
      expect(commanderName(tuple)).toBe(name);
      const code = commanderCode(tuple);
      if (!rated || code === null) { expect(code).toBeNull(); continue; }
      complete.add(code);
      expect(commanderNameFromCode(code)).toBe(name);
    }
    expect(complete.size).toBe(175);
    for (const invalid of ["0", -1, 175, 1.5, null, { value: 0 }]) expect(commanderNameFromCode(invalid)).toBeNull();
  });

  it("matches API build, timing and matchup boundary vectors", () => {
    for (const { input, expected } of golden.repertoires) expect(commanderRepertoire(input)).toEqual(expected);
    for (const { input, expected } of golden.paces) expect(commanderPace(input)).toEqual(expected);
    for (const { input, expected } of golden.matchups) expect(commanderEdge("PvP", input)).toEqual(expected);
  });

  it("uses headers for pace and results but never counts unknown builds, draws or another queue race", () => {
    const games = (matchup: string, count: number, myBuild: string | null, result: string): CommanderRow[] =>
      Array.from({ length: count }, () => ({ matchup, myBuild, durationSec: 300, result }));
    const selected = [...games("PvT", 10, "Detected", "Victory"), ...games("PvP", 8, null, "Defeat"),
      ...games("PvZ", 7, null, "Win"), ...games("PvZ", 1, null, "Draw"), ...games("ZvZ", 8, null, "Win")];
    const partial = buildCommanderProfile(selected);
    expect(partial).toMatchObject({ matchup: "PvT", code: null, axes: [
      { category: "one_trick", sampleSize: 10 }, { category: "timing_attacker", sampleSize: 10 }, { category: null },
    ] });
    expect(buildCommanderProfile([...selected, ...games("PvZ", 1, null, "Loss")])?.code).not.toBeNull();
    expect(buildCommanderProfile([])).toBeNull();
  });
});
