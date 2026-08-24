import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type WorksheetBlock = {
  ty: "mc" | "long" | "scale" | "image" | "replay";
  q: string;
  opts?: string[];
};

type WorksheetTemplate = {
  id: string;
  title: string;
  description: string;
  coachPrompts: string[];
  blocks: WorksheetBlock[];
};

type MatchupKit = {
  matchup: string;
  race: string;
  template: WorksheetTemplate;
  voice: { id: string; title: string; script: string };
  assignment: { id: string; title: string; action: string };
};

type AuthoringKits = {
  version: number;
  matchups: string[];
  universalGuides: Array<{ id: string; label: string; prompts: string[] }>;
  worksheetTemplates: WorksheetTemplate[];
  matchupKits: MatchupKit[];
};

const canonicalMatchups = ["PvP", "PvT", "PvZ", "ZvP", "ZvT", "ZvZ", "TvP", "TvT", "TvZ"];
const kitPath = resolve(process.cwd(), "../../coaching/authoring_kits.json");
const generatedLockerPath = resolve(process.cwd(), "public/coaching/locker-site.html");
const kits = JSON.parse(readFileSync(kitPath, "utf8")) as AuthoringKits;

describe("Locker authoring kits", () => {
  it("covers each canonical matchup exactly once", () => {
    expect(kits.matchups).toEqual(canonicalMatchups);
    expect(kits.matchupKits.map((kit) => kit.matchup)).toEqual(canonicalMatchups);
    expect(new Set(kits.matchupKits.map((kit) => kit.matchup)).size).toBe(9);
  });

  it("keeps every built-in worksheet valid, immutable-friendly, and free of student state", () => {
    const templates = [
      ...kits.worksheetTemplates,
      ...kits.matchupKits.map((kit) => kit.template),
    ];
    const ids = templates.map((template) => template.id);

    expect(kits.worksheetTemplates).toHaveLength(4);
    expect(templates).toHaveLength(13);
    expect(new Set(ids).size).toBe(ids.length);

    for (const template of templates) {
      expect(template.title.trim()).not.toBe("");
      expect(template.description.trim()).not.toBe("");
      expect(template.coachPrompts.length).toBeGreaterThanOrEqual(3);
      expect(template.blocks.length).toBeGreaterThanOrEqual(4);

      for (const block of template.blocks) {
        expect(["mc", "long", "scale", "image", "replay"]).toContain(block.ty);
        expect(block.q.trim()).not.toBe("");
        expect(Object.keys(block).sort()).toEqual(
          block.ty === "mc" ? ["opts", "q", "ty"] : ["q", "ty"],
        );
        if (block.ty === "mc") {
          expect(block.opts?.length ?? 0).toBeGreaterThanOrEqual(2);
          expect(block.opts?.every((option) => option.trim().length > 0)).toBe(true);
        }
      }

      const serialized = JSON.stringify(template);
      for (const forbiddenKey of [
        '"answers"',
        '"studentId"',
        '"userId"',
        '"coachId"',
        '"submittedAt"',
        '"asset"',
        '"img"',
      ]) {
        expect(serialized).not.toContain(forbiddenKey);
      }
    }
  });

  it("ships complete voice and assignment starters for all nine matchups", () => {
    const contentIds = kits.matchupKits.flatMap((kit) => [kit.voice.id, kit.assignment.id]);
    expect(new Set(contentIds).size).toBe(18);

    for (const kit of kits.matchupKits) {
      expect(kit.race.trim()).not.toBe("");
      expect(kit.voice.title).toContain(kit.matchup);
      expect(kit.voice.script.length).toBeGreaterThan(120);
      expect(kit.assignment.title.trim()).not.toBe("");
      expect(kit.assignment.action.length).toBeGreaterThan(80);
    }
  });

  it("embeds the exact validated library in the generated production Locker", () => {
    const generated = readFileSync(generatedLockerPath, "utf8");
    const prefix = "const AUTHORING_KITS=";
    const start = generated.indexOf(prefix);
    const guideStart = generated.indexOf("const GUIDE=", start);
    const end = generated.lastIndexOf(";", guideStart);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(guideStart).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(start);
    expect(JSON.parse(generated.slice(start + prefix.length, end))).toEqual(kits);
    expect(generated).not.toContain("__AUTHORING_KITS__");
  });
});
