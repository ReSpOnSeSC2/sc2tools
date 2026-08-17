import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  ALERT_VISUAL_CATEGORIES,
  ALERT_VISUAL_ENTRIES,
  ALERT_VISUAL_LAYOUTS,
  ALERT_VISUAL_PRESETS,
  ALERT_VISUAL_PRESET_IDS,
  DEFAULT_ALERTS,
  DEFAULT_EVENT_VISUALS,
  RECOMMENDED_EVENT_VISUALS,
  type AlertVisualPresetId,
  isAlertVisualPresetId,
  resolveAlertVisualPreset,
  resolveAlertVisualPresetId,
  sanitizeAlertConfig,
} from "@/lib/multichat/alerts";
import {
  CHAT_EVENT_KINDS,
  type ChatEventKind,
} from "@/lib/multichat/events";

const PUBLIC_DIR = path.join(process.cwd(), "public");

const SC2_3D_PRESET_IDS = [
  "zealot-dance-3d",
  "marine-skyfire-3d",
  "archon-merge-3d",
  "archon-backflip-3d",
  "stalker-blink-3d",
  "carrier-interceptors-3d",
  "zergling-zoomies-3d",
  "baneling-bowling-3d",
  "overlord-party-balloon-3d",
  "battlecruiser-warp-in-3d",
  "mule-money-drop-3d",
] as const satisfies readonly AlertVisualPresetId[];

const EXPECTED_3D_BY_KIND = {
  sub: ["zealot-dance-3d", "stalker-blink-3d"],
  resub: ["archon-merge-3d", "archon-backflip-3d"],
  giftsub: [
    "carrier-interceptors-3d",
    "mule-money-drop-3d",
    "overlord-party-balloon-3d",
  ],
  raid: [
    "marine-skyfire-3d",
    "zergling-zoomies-3d",
    "battlecruiser-warp-in-3d",
  ],
  member: ["archon-merge-3d", "zealot-dance-3d"],
  superchat: ["mule-money-drop-3d", "marine-skyfire-3d"],
  gift: [
    "overlord-party-balloon-3d",
    "carrier-interceptors-3d",
    "mule-money-drop-3d",
  ],
  follow: ["stalker-blink-3d", "zealot-dance-3d"],
  cheer: [
    "archon-backflip-3d",
    "marine-skyfire-3d",
    "baneling-bowling-3d",
  ],
  share: [
    "carrier-interceptors-3d",
    "overlord-party-balloon-3d",
    "zealot-dance-3d",
  ],
  reward: [
    "baneling-bowling-3d",
    "zergling-zoomies-3d",
    "stalker-blink-3d",
  ],
} as const satisfies Record<ChatEventKind, readonly AlertVisualPresetId[]>;

describe("visual alert preset catalog", () => {
  test("ships 50+ stable, unique and complete visual presets", () => {
    expect(ALERT_VISUAL_PRESETS).toHaveLength(57);
    expect(new Set(ALERT_VISUAL_PRESET_IDS).size).toBe(
      ALERT_VISUAL_PRESET_IDS.length,
    );
    expect(ALERT_VISUAL_PRESET_IDS).toEqual(
      ALERT_VISUAL_PRESETS.map((preset) => preset.id),
    );

    for (const preset of ALERT_VISUAL_PRESETS) {
      expect(preset.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(preset.label.trim().length).toBeGreaterThan(0);
      expect(preset.description.trim().length).toBeGreaterThan(20);
      expect(preset.emoji.length).toBeGreaterThan(0);
      expect(preset.callout.trim().length).toBeGreaterThan(0);
      expect(ALERT_VISUAL_CATEGORIES).toContain(preset.category);
      expect(ALERT_VISUAL_LAYOUTS).toContain(preset.layout);
      expect(ALERT_VISUAL_ENTRIES).toContain(preset.entry);
      expect(preset.decorations.length).toBeGreaterThan(0);
      expect(preset.accent).toMatch(/^#[0-9a-f]{6}$/i);
      expect(preset.accentAlt).toMatch(/^#[0-9a-f]{6}$/i);
      if (preset.assetUrl) {
        expect(preset.assetUrl).toMatch(/^\/icons\/sc2\//);
        expect(
          fs.statSync(path.join(PUBLIC_DIR, preset.assetUrl.slice(1))).size,
        ).toBeGreaterThan(1_000);
      }
      if (preset.animationUrl || preset.animationPosterUrl) {
        expect(preset.animationUrl).toBe(
          `/alerts/sc2-3d/${preset.id}.webm`,
        );
        expect(preset.animationPosterUrl).toBe(
          `/alerts/sc2-3d/${preset.id}.webp`,
        );
        expect(preset.assetUrl).toMatch(/^\/icons\/sc2\/units\//);
      }
      expect(isAlertVisualPresetId(preset.id)).toBe(true);
    }
    expect(isAlertVisualPresetId("shuffle")).toBe(false);
    expect(isAlertVisualPresetId("not-a-real-preset")).toBe(false);
  });

  test("groups a substantial roster under every requested category", () => {
    for (const category of ALERT_VISUAL_CATEGORIES) {
      expect(
        ALERT_VISUAL_PRESETS.filter((preset) => preset.category === category)
          .length,
      ).toBeGreaterThanOrEqual(4);
    }

    expect(ALERT_VISUAL_PRESET_IDS).toEqual(
      expect.arrayContaining([
        "laughing-man",
        "frog-hype",
        "frog-sip",
        "frog-bonk",
        "frog-business",
        "frog-party",
        "frog-oracle",
        "cash-pop",
        "money-rain",
        "stonks",
        "jackpot",
        "mule-money-drop",
        "zergling-swarm",
        "battlecruiser-arrival",
        "protoss-warp-in",
        "overlord-delivery",
        "gg-fireworks",
        ...SC2_3D_PRESET_IDS,
        "maximum-vitality",
      ]),
    );
    expect(
      ALERT_VISUAL_PRESETS.filter((preset) => preset.category === "StarCraft"),
    ).toHaveLength(17);
    expect(
      ALERT_VISUAL_PRESETS.filter(
        (preset) => preset.category === "StarCraft"
          && !preset.animationUrl
          && preset.assetUrl,
      ).map((preset) => preset.assetUrl),
    ).toEqual([
      "/icons/sc2/units/mule.png",
      "/icons/sc2/units/zergling.png",
      "/icons/sc2/units/battlecruiser.png",
      "/icons/sc2/buildings/warpgate.png",
      "/icons/sc2/units/overlord.png",
    ]);

    const rendered3d = ALERT_VISUAL_PRESETS.filter(
      (preset) => preset.animationUrl,
    );
    expect(rendered3d.map((preset) => preset.id)).toEqual(SC2_3D_PRESET_IDS);
    for (const preset of rendered3d) {
      expect(preset.category).toBe("StarCraft");
      expect(preset.label).toMatch(/3D$/);
      expect(preset.description).toMatch(/3D|rendered/i);
    }
  });

  test("defaults cover every event kind and preserve the legacy presentation", () => {
    expect(Object.keys(DEFAULT_EVENT_VISUALS).sort()).toEqual(
      [...CHAT_EVENT_KINDS].sort(),
    );
    for (const kind of CHAT_EVENT_KINDS) {
      expect(DEFAULT_EVENT_VISUALS[kind]).toBe("classic");
    }
    expect(DEFAULT_ALERTS).toEqual({
      eventVisuals: DEFAULT_EVENT_VISUALS,
      motion: "full",
      durationSec: 8,
      showHistory: true,
    });
  });
});

describe("sanitizeAlertConfig", () => {
  test("null and malformed values produce a fresh, complete legacy config", () => {
    for (const raw of [null, undefined, "junk", 42, []]) {
      expect(sanitizeAlertConfig(raw)).toEqual(DEFAULT_ALERTS);
    }
    expect(sanitizeAlertConfig(null).eventVisuals).not.toBe(
      DEFAULT_EVENT_VISUALS,
    );
  });

  test("merges partial maps, keeps shuffle, and rejects unknown selections", () => {
    const result = sanitizeAlertConfig({
      eventVisuals: {
        sub: "laughing-man",
        raid: "shuffle",
        follow: "not-real",
        dance: "cash-pop",
      },
      motion: "maximum",
      durationSec: 99,
      showHistory: false,
      ignored: "drop me",
    });

    expect(result.eventVisuals.sub).toBe("laughing-man");
    expect(result.eventVisuals.raid).toBe("shuffle");
    expect(result.eventVisuals.follow).toBe("classic");
    expect(result.eventVisuals.giftsub).toBe("classic");
    expect(Object.keys(result.eventVisuals).sort()).toEqual(
      [...CHAT_EVENT_KINDS].sort(),
    );
    expect(result.motion).toBe("maximum");
    expect(result.durationSec).toBe(15);
    expect(result.showHistory).toBe(false);
    expect((result as unknown as Record<string, unknown>).ignored).toBeUndefined();
  });

  test("validates motion and boolean strictly while clamping duration to 3-15", () => {
    expect(
      sanitizeAlertConfig({
        motion: "warp-speed",
        durationSec: -20,
        showHistory: "yes",
      }),
    ).toMatchObject({ motion: "full", durationSec: 3, showHistory: true });
    expect(sanitizeAlertConfig({ durationSec: 12.6 }).durationSec).toBe(
      13,
    );
    expect(sanitizeAlertConfig({ durationSec: "4" }).durationSec).toBe(
      4,
    );
    expect(sanitizeAlertConfig({ durationSec: "never" }).durationSec).toBe(
      8,
    );
    expect(sanitizeAlertConfig({ motion: "subtle" }).motion).toBe(
      "subtle",
    );
  });
});

describe("deterministic visual shuffle", () => {
  test("a direct choice resolves without changing it", () => {
    expect(resolveAlertVisualPresetId("frog-business", "member", "yt:1")).toBe(
      "frog-business",
    );
    expect(
      resolveAlertVisualPreset("cash-pop", "superchat", "yt:2").label,
    ).toBe("Cash Pop");
  });

  test("shuffle is deterministic, valid and confined to each kind's curated pool", () => {
    for (const kind of CHAT_EVENT_KINDS) {
      const pool = RECOMMENDED_EVENT_VISUALS[kind];
      expect(pool.length).toBeGreaterThanOrEqual(6);
      expect(new Set(pool).size).toBe(pool.length);
      for (const id of pool) expect(isAlertVisualPresetId(id)).toBe(true);

      for (let index = 0; index < 50; index += 1) {
        const identity = `twitch:event-${index}`;
        const first = resolveAlertVisualPresetId("shuffle", kind, identity);
        const second = resolveAlertVisualPresetId("shuffle", kind, identity);
        expect(second).toBe(first);
        expect(pool).toContain(first);
        expect(resolveAlertVisualPreset("shuffle", kind, identity).id).toBe(
          first,
        );
      }
    }
  });

  test("curation gives each semantic kind an appropriate signature option", () => {
    expect(RECOMMENDED_EVENT_VISUALS.sub).toContain("level-up");
    expect(RECOMMENDED_EVENT_VISUALS.resub).toContain("victory-lap");
    expect(RECOMMENDED_EVENT_VISUALS.giftsub).toContain("money-rain");
    expect(RECOMMENDED_EVENT_VISUALS.raid).toContain("raid-boss");
    expect(RECOMMENDED_EVENT_VISUALS.member).toContain("cozy-welcome");
    expect(RECOMMENDED_EVENT_VISUALS.superchat).toContain("cash-pop");
    expect(RECOMMENDED_EVENT_VISUALS.gift).toContain("jackpot");
    expect(RECOMMENDED_EVENT_VISUALS.follow).toContain("heart-bloom");
    expect(RECOMMENDED_EVENT_VISUALS.cheer).toContain("airhorn");
    expect(RECOMMENDED_EVENT_VISUALS.share).toContain("community-hug");
    expect(RECOMMENDED_EVENT_VISUALS.reward).toContain("plot-twist");
  });

  test("curates relevant 3D moments for every notification kind", () => {
    for (const kind of CHAT_EVENT_KINDS) {
      expect(RECOMMENDED_EVENT_VISUALS[kind]).toEqual(
        expect.arrayContaining([...EXPECTED_3D_BY_KIND[kind]]),
      );
    }

    const discoverable3d = new Set(
      CHAT_EVENT_KINDS.flatMap((kind) => RECOMMENDED_EVENT_VISUALS[kind])
        .filter((id) => id.endsWith("-3d")),
    );
    expect([...discoverable3d].sort()).toEqual([...SC2_3D_PRESET_IDS].sort());
  });
});
