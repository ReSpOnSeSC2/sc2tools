/**
 * Roster icons — the resolver behind the rails' 3D thumbnails.
 *
 * ``canonicalSpriteName`` is THE alias authority: the map's
 * ``resolveSprite`` and the DOM ``<img>`` in ``ReplayIcon`` both go
 * through it, so ``BarracksTechLab`` folds onto ``TechLab`` in exactly
 * one place. These tests pin the fold, the per-side colour, and the
 * names that must NOT resolve (they are the ones that keep their flat
 * command-card icon).
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalSpriteName,
  resolveSprite,
  SPRITE_BASE,
  spriteIconUrl,
} from "@/lib/spriteSheets";
import { SPRITE_MANIFEST } from "@/lib/spriteManifest.generated";
import { getIconPath } from "@/lib/sc2-icons";

describe("canonicalSpriteName", () => {
  it("passes a name that IS a sheet straight through", () => {
    expect(canonicalSpriteName("Marine")).toBe("Marine");
    expect(canonicalSpriteName("CommandCenter")).toBe("CommandCenter");
  });

  it("folds the Terran add-ons onto the two shared models", () => {
    // SC2 ships one techlab.m3 and one reactor.m3; the tracker names
    // them per parent structure.
    expect(canonicalSpriteName("BarracksTechLab")).toBe("TechLab");
    expect(canonicalSpriteName("FactoryTechLab")).toBe("TechLab");
    expect(canonicalSpriteName("StarportTechLab")).toBe("TechLab");
    expect(canonicalSpriteName("BarracksReactor")).toBe("Reactor");
    expect(canonicalSpriteName("FactoryReactor")).toBe("Reactor");
    expect(canonicalSpriteName("StarportReactor")).toBe("Reactor");
  });

  it("folds mode / state variants onto the base model", () => {
    expect(canonicalSpriteName("SiegeTankSieged")).toBe("SiegeTank");
    expect(canonicalSpriteName("VikingFighter")).toBe("Viking");
    expect(canonicalSpriteName("CommandCenterFlying")).toBe("CommandCenter");
    expect(canonicalSpriteName("SupplyDepotLowered")).toBe("SupplyDepot");
    expect(canonicalSpriteName("RefineryRich")).toBe("Refinery");
    expect(canonicalSpriteName("ExtractorRich")).toBe("Extractor");
    expect(canonicalSpriteName("AssimilatorRich")).toBe("Assimilator");
    expect(canonicalSpriteName("LurkerMPBurrowed")).toBe("Lurker");
  });

  it("strips a bare state suffix that has no explicit alias", () => {
    expect(canonicalSpriteName("RoachBurrowed")).toBe("Roach");
    expect(canonicalSpriteName("ZerglingBurrowed")).toBe("Zergling");
  });

  it("returns null for names with no 3D render", () => {
    // These are exactly the ones that must keep their flat icon.
    // Broodling has no extractable model at all…
    expect(canonicalSpriteName("Broodling")).toBeNull();
    // …and no upgrade has one, which is the whole upgrade section.
    expect(canonicalSpriteName("StimPack")).toBeNull();
    expect(canonicalSpriteName("CombatShield")).toBeNull();
    expect(canonicalSpriteName("TerranInfantryWeaponsLevel1")).toBeNull();
    expect(canonicalSpriteName("WarpGateResearch")).toBeNull();
    // A name that is neither a sheet nor an alias nor a suffixed base.
    expect(canonicalSpriteName("NotAThing")).toBeNull();
  });

  it("keeps the Adept phase-shift on the Adept model, per the alias table", () => {
    // The map already folds it (a shade IS an Adept), so the rails must
    // not invent a different answer — same table, same result.
    expect(canonicalSpriteName("AdeptPhaseShift")).toBe("Adept");
  });

  it("is the SAME table ``resolveSprite`` uses, not a copy", () => {
    for (const raw of ["BarracksTechLab", "SiegeTankSieged", "AssimilatorRich"]) {
      const kind = SPRITE_MANIFEST[canonicalSpriteName(raw) ?? ""]?.kind;
      const resolved = resolveSprite(raw, kind === "unit" ? "unit" : "building");
      expect(resolved?.name).toBe(canonicalSpriteName(raw));
    }
  });
});

describe("spriteIconUrl", () => {
  it("builds <base>/icons/<Name>_<color>.webp", () => {
    expect(spriteIconUrl("TechLab", "blue")).toBe(`${SPRITE_BASE}/icons/TechLab_blue.webp`);
    expect(spriteIconUrl("Marine", "red")).toBe(`${SPRITE_BASE}/icons/Marine_red.webp`);
  });

  it("defaults the base to /sprites", () => {
    // NEXT_PUBLIC_SPRITE_BASE is unset in tests, so this is the shipped
    // default and the path the copied icons actually live at.
    expect(SPRITE_BASE).toBe("/sprites");
  });
});

describe("the shipped icon set", () => {
  const dir = path.join(process.cwd(), "public", "sprites", "icons");
  const present = fs.existsSync(dir);

  it("has a red and a blue render for every sheet in the manifest", () => {
    if (!present) {
      // The repo ships without ``public/`` in some checkouts; the CDN
      // build is the source of truth there. Nothing to assert.
      expect(present).toBe(false);
      return;
    }
    const files = new Set(fs.readdirSync(dir));
    const missing: string[] = [];
    for (const name of Object.keys(SPRITE_MANIFEST)) {
      for (const color of ["red", "blue"] as const) {
        if (!files.has(`${name}_${color}.webp`)) missing.push(`${name}_${color}`);
      }
    }
    expect(missing).toEqual([]);
    expect(files.size).toBe(Object.keys(SPRITE_MANIFEST).length * 2);
  });
});

describe("the flat-icon fallback is real", () => {
  it("still resolves a command-card icon for the names with no render", () => {
    // If this ever returns null the rail would drop to a monogram, so
    // it is worth asserting rather than assuming.
    expect(getIconPath("Broodling", "unit")).toBeNull();
    expect(getIconPath("StimPack", "upgrade")).toBeTruthy();
    expect(getIconPath("CombatShield", "upgrade")).toBeTruthy();
    expect(getIconPath("TerranInfantryWeaponsLevel1", "upgrade")).toBeTruthy();
  });
});
