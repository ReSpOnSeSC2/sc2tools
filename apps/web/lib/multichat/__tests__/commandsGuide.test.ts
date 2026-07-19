import { describe, expect, test } from "vitest";
import { COMMAND_GROUPS, buildBioText } from "@/lib/multichat/commandsGuide";

describe("commands guide", () => {
  test("bio text covers every documented command", () => {
    const bio = buildBioText("protoss");
    for (const cmd of ["!win", "!loss", "!rank", "!1", "!opponent", "!mmr", "!build"]) {
      expect(bio).toContain(cmd);
    }
    expect(bio).toContain("2 XP per message");
    expect(bio).toContain("Raid +100");
    expect(bio).toContain("MOTHERSHIP");
  });

  test("ladder line follows the chosen race", () => {
    expect(buildBioText("terran")).toContain("BATTLECRUISER");
    expect(buildBioText("terran")).toContain("SCV → Marine");
    expect(buildBioText("zerg")).toContain("SWARM HOST");
  });

  test("groups are complete and well-formed", () => {
    expect(COMMAND_GROUPS.map((g) => g.id)).toEqual([
      "predictions",
      "loyalty",
      "voting",
      "stats",
    ]);
    for (const g of COMMAND_GROUPS) {
      expect(g.commands.length).toBeGreaterThan(0);
      for (const c of g.commands) expect(c.syntax.startsWith("!")).toBe(true);
    }
  });
});
