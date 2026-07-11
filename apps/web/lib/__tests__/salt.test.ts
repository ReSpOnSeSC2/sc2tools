import { describe, expect, test } from "vitest";
import {
  encodeSalt,
  encodeSaltDetailed,
  saltItemFor,
  type SaltStep,
} from "../salt";

describe("encodeSalt — known-good string", () => {
  test("3-step Protoss opener encodes to the hand-computed string", () => {
    // Hand-computed chunks (char = value + 32, supply biased by -4):
    //   14  0:18 Pylon      -> "* 2 ;"  (10, 0, 18, structure=0, 27)
    //   15  0:40 Gateway    -> "+ H 8"  (11, 0, 40, structure=0, 24)
    //   22  2:06 Adept      -> '2"&!S'  (18, 2,  6, unit=1,      51)
    // The first two chunks appear verbatim in spawningtool.com's own
    // SALT encoding of build 93714, which pins the whole layout.
    const steps: SaltStep[] = [
      { supply: 14, timeSec: 18, kind: "structure", name: "Pylon" },
      { supply: 15, timeSec: 40, kind: "structure", name: "Gateway" },
      { supply: 22, timeSec: 126, kind: "unit", name: "Adept" },
    ];
    expect(encodeSalt("PvZ Stargate", steps)).toBe(
      '$PvZ Stargate|||~* 2 ;+ H 82"&!S',
    );
  });

  test("morphs encode with type code 2 and the morph table id", () => {
    // 19 1:28 Orbital Command -> "/!<\" " — matches spawningtool's
    // encoding of build 179397 chunk-for-chunk.
    const steps: SaltStep[] = [
      // The repo files Orbital Command under buildings; the SALT
      // table kind (morph) must win over step.kind.
      { supply: 19, timeSec: 88, kind: "structure", name: "OrbitalCommand" },
    ];
    expect(encodeSalt("TvX", steps)).toBe('$TvX|||~/!<" ');
  });

  test("upgrades encode with type code 3", () => {
    // 73 5:51 Stimpack -> "e%S#+" (from spawningtool build 179397).
    const steps: SaltStep[] = [
      { supply: 73, timeSec: 351, kind: "upgrade", name: "Stimpack" },
    ];
    expect(encodeSalt("TvX", steps)).toBe("$TvX|||~e%S#+");
  });
});

describe("saltItemFor — name normalization", () => {
  test("spacing / casing / separator variants resolve identically", () => {
    const expected = { kind: "structure", id: 41 };
    expect(saltItemFor("SpawningPool")).toEqual(expected);
    expect(saltItemFor("Spawning Pool")).toEqual(expected);
    expect(saltItemFor("spawningpool")).toEqual(expected);
    expect(saltItemFor("spawning_pool")).toEqual(expected);
    expect(saltItemFor("SPAWNING-POOL")).toEqual(expected);
  });

  test("SALT-kind reclassification: morphs filed as buildings/units", () => {
    expect(saltItemFor("Orbital Command")).toEqual({ kind: "morph", id: 0 });
    expect(saltItemFor("Lair")).toEqual({ kind: "morph", id: 3 });
    expect(saltItemFor("Baneling")).toEqual({ kind: "morph", id: 7 });
    expect(saltItemFor("Archon")).toEqual({ kind: "morph", id: 13 });
  });

  test("add-ons resolve per parent structure, with a bare-name default", () => {
    expect(saltItemFor("BarracksTechLab")).toEqual({ kind: "structure", id: 16 });
    expect(saltItemFor("Tech Lab (Barracks)")).toEqual({ kind: "structure", id: 16 });
    expect(saltItemFor("StarportReactor")).toEqual({ kind: "structure", id: 11 });
    expect(saltItemFor("Reactor")).toEqual({ kind: "structure", id: 9 });
  });

  test("tiered upgrades drop their level suffix", () => {
    const expected = { kind: "upgrade", id: 19 };
    expect(saltItemFor("ProtossGroundWeaponsLevel1")).toEqual(expected);
    expect(saltItemFor("Protoss Ground Weapons Level 2")).toEqual(expected);
    expect(saltItemFor("protossgroundweapons3")).toEqual(expected);
    expect(saltItemFor("TerranInfantryWeaponsLevel1")).toEqual({
      kind: "upgrade",
      id: 2,
    });
  });

  test("sc2reader internal upgrade names resolve", () => {
    expect(saltItemFor("zerglingmovementspeed")).toEqual({ kind: "upgrade", id: 42 });
    expect(saltItemFor("Metabolic Boost")).toEqual({ kind: "upgrade", id: 42 });
    expect(saltItemFor("ShieldWall")).toEqual({ kind: "upgrade", id: 16 });
    expect(saltItemFor("WarpGateResearch")).toEqual({ kind: "upgrade", id: 26 });
    expect(saltItemFor("highcapacitybarrels")).toEqual({ kind: "upgrade", id: 10 });
  });

  test("SALT's own quirky spellings are honored", () => {
    // The SALT unit table pluralizes Adepts; both forms must hit id 51.
    expect(saltItemFor("Adept")).toEqual({ kind: "unit", id: 51 });
    expect(saltItemFor("Adepts")).toEqual({ kind: "unit", id: 51 });
    // Hellbat is "Battle Hellion" (40); internal type is HellionTank.
    expect(saltItemFor("Hellbat")).toEqual({ kind: "unit", id: 40 });
    expect(saltItemFor("HellionTank")).toEqual({ kind: "unit", id: 40 });
  });

  test("unknown or empty names return null", () => {
    expect(saltItemFor("ShieldBattery")).toBeNull();
    expect(saltItemFor("Definitely Not A Unit")).toBeNull();
    expect(saltItemFor("")).toBeNull();
    expect(saltItemFor("   ")).toBeNull();
  });
});

describe("encodeSaltDetailed — unknown-name skipping", () => {
  test("unmappable steps are skipped, reported, and never thrown on", () => {
    const steps: SaltStep[] = [
      { supply: 14, timeSec: 18, kind: "structure", name: "Pylon" },
      // Shield Battery postdates the SALT map's tables.
      { supply: 20, timeSec: 130, kind: "structure", name: "ShieldBattery" },
      { supply: 15, timeSec: 40, kind: "structure", name: "Gateway" },
      { supply: 30, timeSec: 200, kind: "upgrade", name: "FluxVanes" },
    ];
    const { salt, skipped } = encodeSaltDetailed("Skips", steps);
    expect(skipped).toEqual(["ShieldBattery", "FluxVanes"]);
    expect(salt).toBe("$Skips|||~* 2 ;+ H 8");
    // The lenient wrapper produces the same string without throwing.
    expect(encodeSalt("Skips", steps)).toBe(salt);
  });

  test("a build of only unknown steps still yields a valid header", () => {
    const steps: SaltStep[] = [
      { supply: 12, timeSec: 0, kind: "unit", name: "NydusWorm" },
    ];
    const { salt, skipped } = encodeSaltDetailed("Empty", steps);
    expect(salt).toBe("$Empty|||~");
    expect(skipped).toEqual(["NydusWorm"]);
  });
});

describe("encodeSalt — bounds clamping", () => {
  const body = (salt: string): string => salt.slice(salt.indexOf("~") + 1);

  test("supply clamps to the encodable 5..98 window", () => {
    const at = (supply: number): string =>
      body(
        encodeSalt("T", [{ supply, timeSec: 0, kind: "unit", name: "Probe" }]),
      );
    // 200 -> 98 -> value 94 -> "~"; 1 -> 5 -> value 1 -> "!".
    expect(at(200).charAt(0)).toBe("~");
    expect(at(1).charAt(0)).toBe("!");
    expect(at(-7).charAt(0)).toBe("!");
    // Non-finite supply falls back to SALT's blank supply (value 0).
    expect(at(Number.NaN).charAt(0)).toBe(" ");
  });

  test("time clamps to 0:00..94:59", () => {
    const at = (timeSec: number): string =>
      body(
        encodeSalt("T", [{ supply: 12, timeSec, kind: "unit", name: "Probe" }]),
      );
    // Negative time floors to 0:00 (two spaces).
    expect(at(-5).slice(1, 3)).toBe("  ");
    // Absurdly large time pins to 94:59 -> "~" (94) and "[" (59).
    expect(at(999999).slice(1, 3)).toBe("~[");
    // Fractional seconds round: 125.6 -> 2:06 -> '"' (2) and "&" (6).
    expect(at(125.6).slice(1, 3)).toBe('"&');
  });

  test("chunks are always exactly 5 chars of printable ASCII", () => {
    const salt = encodeSalt("T", [
      { supply: 999, timeSec: 999999, kind: "unit", name: "Probe" },
      { supply: -1, timeSec: -1, kind: "structure", name: "Pylon" },
    ]);
    const chunks = body(salt);
    expect(chunks.length).toBe(10);
    for (const ch of chunks) {
      const code = ch.charCodeAt(0);
      expect(code).toBeGreaterThanOrEqual(32);
      expect(code).toBeLessThanOrEqual(126);
    }
  });
});

describe("encodeSalt — metadata section", () => {
  test('header is "$" + title + "|||~" (empty author/description)', () => {
    expect(encodeSalt("My Build", [])).toBe("$My Build|||~");
  });

  test("separator characters in the title are neutralized", () => {
    // "|" and "~" would corrupt the metadata parse in the reference
    // decoder, which splits on "|" and scans to the first "~".
    expect(encodeSalt("A|B~C", [])).toBe("$A-B-C|||~");
  });

  test("non-printable-ASCII title characters are dropped", () => {
    expect(encodeSalt("Léon\tBuild", [])).toBe("$LonBuild|||~");
  });

  test("optional author/description ride along sanitized", () => {
    const { salt } = encodeSaltDetailed("T", [], {
      author: "sc2tools",
      description: "PvZ|opener",
    });
    expect(salt).toBe("$T|sc2tools|PvZ-opener|~");
  });
});
