import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const folders: string[] = [];
const day = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
const replay = resolve("../replay-engine/tests/fixtures/replays/ladder_tvt_tourmaline.SC2Replay");
const scoutAssets = resolve("public/daily/scout/v1");
const scout = "scripts/build-daily-scout.mjs";
const scoutPlan = {
  replay, perspective: "HADB", consented: true, side: "opp",
  crop: { left: 0, bottom: 0, width: 100, height: 100 },
};

function directory() {
  const temp = mkdtempSync(join(tmpdir(), "daily-scout-builder-"));
  folders.push(temp);
  return temp;
}

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  return result;
}

afterEach(() => {
  const root = resolve(tmpdir());
  for (const folder of folders.splice(0)) {
    if (resolve(folder).startsWith(join(root, "daily-scout-builder-"))) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
});

describe("Daily builder output isolation", () => {
  it.each([
    [scout, resolve("public/daily/v1")],
    ["scripts/build-daily-packs.mjs", scoutAssets],
  ])("prevents %s from rewriting the other mode's index", (builder, assets) => {
    const out = join(directory(), "other-mode");
    cpSync(assets, out, { recursive: true });
    const index = join(out, "index.json");
    const original = readFileSync(index);
    const result = run(builder, ["--practice", "--out", out]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("different Daily pack type");
    expect(readFileSync(index)).toEqual(original);
  }, 30_000);
});

const python = process.env.SCOUT_TEST_PYTHON ?? "python";
const parser = resolve("../replay-engine/scripts/scout_source.py");

function extract(args: string[]) {
  return spawnSync(python, [parser, ...args], { encoding: "utf8", windowsHide: true });
}

describe.skipIf(!process.env.SCOUT_TEST_PYTHON)("Daily Scout real replay authoring", () => {
  it("extracts the released label and actual placements from the requested player slot", () => {
    const args = ["--replay", replay, "--perspective", "HADB"];
    const result = extract([...args, "--side", "opp"]);
    expect(result.status).toBe(0);
    const input = JSON.parse(result.stdout);
    expect(input.strategy).toBe("Terran - Fast 3 CC");
    expect(input.buildings).toContainEqual({ owner: "opp", name: "CommandCenter", x: 27, y: 52, t: 136.741 });
    expect(result.stdout).not.toMatch(/HADB|WindMoon|Tourmaline|\.SC2Replay/);
    const otherPerspective = JSON.parse(extract(["--replay", replay, "--perspective", "WindMoon", "--side", "me"]).stdout);
    expect(otherPerspective.playerSlot).toBe(input.playerSlot);
    expect(otherPerspective.replaySha256).toBe(input.replaySha256);
  });

  it("rejects ambiguous or non-replay detector inputs", () => {
    const wrong = extract(["--replay", replay, "--perspective", "not present", "--side", "me"]);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("Could not establish the replay side");
    const invalid = join(directory(), "forged.json");
    writeFileSync(invalid, JSON.stringify({ strategy: "Terran - Fast 3 CC", playerSlot: 2, side: "opp" }));
    const forged = extract(["--replay", invalid, "--perspective", "HADB", "--side", "opp"]);
    expect(forged.status).toBe(1);
    expect(forged.stdout).toBe("");
  });

  it("rejects teams in the private replay parser", () => {
    const team = resolve("../replay-engine/tests/fixtures/replays/ladder_2v2_crimson_research_lab.SC2Replay");
    const result = extract(["--replay", team, "--perspective", "TcAA", "--side", "me"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("rejects the same player slot through a copied replay, another perspective and different crop", () => {
    const temp = directory();
    const copy = join(temp, "copy.SC2Replay");
    copyFileSync(replay, copy);
    const out = join(temp, "scout");
    cpSync(scoutAssets, out, { recursive: true });
    const index = join(out, "index.json");
    const original = readFileSync(index);
    const distinctPaths = Array.from({ length: 4 }, (_, i) => {
      const path = i === 0 ? copy : join(temp, `copy-${i}.SC2Replay`);
      if (i) copyFileSync(replay, path);
      return { ...scoutPlan, replay: path, perspective: "WindMoon", side: "me",
        crop: { left: -2 - i, bottom: 0, width: 120, height: 100 } };
    });
    const sources = [scoutPlan, ...distinctPaths];
    const plan = join(temp, "plan.json");
    writeFileSync(plan, JSON.stringify({ days: [{ day, sources }] }));
    const result = run(scout, ["--plan", plan, "--out", out, "--python", python]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("A replay player slot can only appear once");
    expect(readFileSync(index)).toEqual(original);
  }, 30_000);
});
