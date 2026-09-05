import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SPRITE_MANIFEST } from "../spriteManifest.generated";
import { resolveSprite, spriteAnim } from "../spriteSheets";

type Clip = {
  race: string;
  frameSize: number;
  facings: number;
  sourceAnimation: { group: string; srcRange: number[]; srcFrames: number[] };
  files: Record<"red" | "blue", { sha256: string; bytes: number; distinctFramesPerFacing: number[] }>;
};
const ledger = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "../../tools/sc2-alert-renders/replay-attack-clips.json"), "utf8")) as {
  clips: Record<string, Clip>;
  withoutAttackSequence: string[];
};

describe("shipped native attack sprites", () => {
  it("resolves every declared clip to both local release files with matching geometry and hashes", () => {
    expect(Object.keys(ledger.clips).length).toBeGreaterThan(30);
    for (const [name, clip] of Object.entries(ledger.clips)) {
      const sprite = resolveSprite(name, "unit")!;
      const handle = spriteAnim(sprite, "Attack");
      expect(handle.name, name).toBe("Attack");
      expect(handle.anim.frames, name).toBe(8);
      expect(handle.anim.cols, name).toBe(8);
      expect(handle.anim.rows, name).toBe(8);
      expect(sprite.meta.frameSize, name).toBe(clip.frameSize);
      expect(sprite.meta.facings, name).toBe(clip.facings);
      expect(clip.sourceAnimation.group, name).toMatch(/\bAttack\b/);
      expect(clip.sourceAnimation.srcRange[1] - clip.sourceAnimation.srcRange[0], name).toBeLessThanOrEqual(30);
      for (const color of ["red", "blue"] as const) {
        const url = color === "red" ? handle.redUrl : handle.blueUrl;
        expect(url, name).toBe(`/replay-attacks/units/${clip.race}/${name}_${color}_Attack.webp`);
        const file = fs.readFileSync(path.join(process.cwd(), "public", url));
        expect(file.toString("ascii", 0, 4), name).toBe("RIFF");
        expect(file.toString("ascii", 8, 12), name).toBe("WEBP");
        expect(file.length, name).toBe(clip.files[color].bytes);
        expect(createHash("sha256").update(file).digest("hex"), name).toBe(clip.files[color].sha256);
        expect(Math.min(...clip.files[color].distinctFramesPerFacing), name).toBeGreaterThan(1);
      }
    }
  });

  it("does not relabel idle artwork as an Attack clip for models without an authored sequence", () => {
    for (const name of ledger.withoutAttackSequence) {
      expect(SPRITE_MANIFEST[name].anims.Attack, name).toBeUndefined();
      expect(spriteAnim(resolveSprite(name, "unit")!, "Attack").name, name).toBe("Stand");
    }
  });
});
