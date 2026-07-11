import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERLAY_ACCENT,
  OVERLAY_PANEL_REFERENCE_HEX,
  OVERLAY_THEME_PRESETS,
  OVERLAY_THEME_VERSION,
  accentContrastOnPanel,
  appendOverlayThemeToUrl,
  contrastRatio,
  decodeOverlayTheme,
  encodeOverlayTheme,
  expandHex,
  isDefaultOverlayTheme,
  normalizeOverlayTheme,
  relativeLuminance,
  themeToCssVars,
  type OverlayTheme,
} from "@/lib/overlayTheme";

/** Craft a raw base64url ?theme= value from an arbitrary object —
 * bypasses encodeOverlayTheme's own normalization so tests can feed
 * genuinely hostile payloads through the decode path. */
function rawParam(payload: unknown): string {
  return btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("encode/decode round-trip", () => {
  it("round-trips a fully-populated theme", () => {
    const theme: OverlayTheme = {
      accent: "#3ec0c7",
      scale: 1.25,
      opacity: 0.55,
      radius: "pill",
      font: "mono",
    };
    expect(decodeOverlayTheme(encodeOverlayTheme(theme))).toEqual(theme);
  });

  it("round-trips the empty (default) theme", () => {
    const encoded = encodeOverlayTheme({});
    expect(decodeOverlayTheme(encoded)).toEqual({});
  });

  it("round-trips every preset", () => {
    for (const preset of OVERLAY_THEME_PRESETS) {
      expect(decodeOverlayTheme(encodeOverlayTheme(preset.theme))).toEqual(
        normalizeOverlayTheme(preset.theme),
      );
    }
  });

  it("produces URL-safe output (base64url alphabet only)", () => {
    const encoded = encodeOverlayTheme({
      accent: "#ffd166",
      scale: 0.8,
      opacity: 0.31,
      radius: "sharp",
      font: "condensed",
    });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("drops default-valued tokens during encode (canonical minimal form)", () => {
    const decoded = decodeOverlayTheme(
      encodeOverlayTheme({ scale: 1, opacity: 0.94, radius: "rounded", font: "default" }),
    );
    expect(decoded).toEqual({});
  });
});

describe("decode: hostile input falls back to default silently", () => {
  it("handles null/undefined/empty", () => {
    expect(decodeOverlayTheme(null)).toEqual({});
    expect(decodeOverlayTheme(undefined)).toEqual({});
    expect(decodeOverlayTheme("")).toEqual({});
  });

  it("rejects junk base64", () => {
    expect(decodeOverlayTheme("!!!not-base64!!!")).toEqual({});
    expect(decodeOverlayTheme("%%2525")).toEqual({});
    expect(decodeOverlayTheme("<script>alert(1)</script>")).toEqual({});
  });

  it("rejects valid base64 that is not JSON", () => {
    expect(decodeOverlayTheme(btoa("hello world").replace(/=+$/, ""))).toEqual(
      {},
    );
  });

  it("rejects JSON that is not an object", () => {
    expect(decodeOverlayTheme(rawParam("a string"))).toEqual({});
    expect(decodeOverlayTheme(rawParam([1, 2, 3]))).toEqual({});
    expect(decodeOverlayTheme(rawParam(42))).toEqual({});
    expect(decodeOverlayTheme(rawParam(null))).toEqual({});
  });

  it("rejects wrong/missing version", () => {
    expect(
      decodeOverlayTheme(rawParam({ v: 2, accent: "#ffffff" })),
    ).toEqual({});
    expect(decodeOverlayTheme(rawParam({ accent: "#ffffff" }))).toEqual({});
    expect(
      decodeOverlayTheme(rawParam({ v: "1", accent: "#ffffff" })),
    ).toEqual({});
  });

  it("rejects oversized payloads outright", () => {
    const huge = rawParam({
      v: OVERLAY_THEME_VERSION,
      accent: "#ffffff",
      junk: "x".repeat(10_000),
    });
    expect(huge.length).toBeGreaterThan(512);
    expect(decodeOverlayTheme(huge)).toEqual({});
  });

  it("drops XSS-ish accent strings", () => {
    for (const evil of [
      "</style><script>alert(1)</script>",
      "red; background:url(//evil)",
      "var(--steal)",
      "#fff; }",
      "url(javascript:alert(1))",
      "expression(alert(1))",
    ]) {
      const decoded = decodeOverlayTheme(
        rawParam({ v: OVERLAY_THEME_VERSION, accent: evil }),
      );
      expect(decoded.accent).toBeUndefined();
    }
  });

  it("drops absurd or mistyped numbers", () => {
    expect(
      decodeOverlayTheme(
        rawParam({ v: OVERLAY_THEME_VERSION, scale: 999 }),
      ).scale,
    ).toBeUndefined();
    expect(
      decodeOverlayTheme(
        rawParam({ v: OVERLAY_THEME_VERSION, scale: "1.25" }),
      ).scale,
    ).toBeUndefined();
    expect(
      decodeOverlayTheme(
        rawParam({ v: OVERLAY_THEME_VERSION, opacity: "0.5" }),
      ).opacity,
    ).toBeUndefined();
    expect(
      decodeOverlayTheme(
        rawParam({ v: OVERLAY_THEME_VERSION, opacity: Number.NaN }),
      ).opacity,
    ).toBeUndefined();
  });

  it("clamps out-of-range opacity instead of dropping it", () => {
    expect(
      decodeOverlayTheme(
        rawParam({ v: OVERLAY_THEME_VERSION, opacity: 999 }),
      ).opacity,
    ).toBe(1);
    expect(
      decodeOverlayTheme(
        rawParam({ v: OVERLAY_THEME_VERSION, opacity: -5 }),
      ).opacity,
    ).toBe(0);
  });

  it("drops unknown enum values and unknown keys", () => {
    const decoded = decodeOverlayTheme(
      rawParam({
        v: OVERLAY_THEME_VERSION,
        radius: "bouncy",
        font: "comic-sans",
        extra: "field",
        accent: "#3ec",
      }),
    );
    expect(decoded).toEqual({ accent: "#3ec" });
  });

  it("survives prototype-pollution shaped JSON", () => {
    // Hand-built JSON so __proto__ is a real serialized key, not an
    // object-literal prototype assignment.
    const json =
      '{"v":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}},"accent":"#abc"}';
    const raw = btoa(json)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const decoded = decodeOverlayTheme(raw);
    expect(decoded).toEqual({ accent: "#abc" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("normalizeOverlayTheme", () => {
  it("accepts #rgb and #rrggbb, lowercases, rejects everything else", () => {
    expect(normalizeOverlayTheme({ accent: "#3EC" }).accent).toBe("#3ec");
    expect(normalizeOverlayTheme({ accent: "#3EC0C7" }).accent).toBe(
      "#3ec0c7",
    );
    expect(normalizeOverlayTheme({ accent: "red" }).accent).toBeUndefined();
    expect(normalizeOverlayTheme({ accent: "#zzz" }).accent).toBeUndefined();
    expect(
      normalizeOverlayTheme({ accent: "#12345" }).accent,
    ).toBeUndefined();
    expect(
      normalizeOverlayTheme({ accent: "#12345678" }).accent,
    ).toBeUndefined();
  });

  it("only accepts scales from the allowlist", () => {
    expect(normalizeOverlayTheme({ scale: 0.8 }).scale).toBe(0.8);
    expect(normalizeOverlayTheme({ scale: 0.85 }).scale).toBeUndefined();
    expect(normalizeOverlayTheme({ scale: 1 }).scale).toBeUndefined();
  });

  it("returns {} for non-object input", () => {
    expect(normalizeOverlayTheme(null)).toEqual({});
    expect(normalizeOverlayTheme("theme")).toEqual({});
    expect(normalizeOverlayTheme([1])).toEqual({});
    expect(normalizeOverlayTheme(undefined)).toEqual({});
  });
});

describe("isDefaultOverlayTheme / appendOverlayThemeToUrl", () => {
  it("treats {} and default-valued themes as default", () => {
    expect(isDefaultOverlayTheme({})).toBe(true);
    expect(isDefaultOverlayTheme({ scale: 1, radius: "rounded" })).toBe(true);
    expect(isDefaultOverlayTheme({ accent: "#fff" })).toBe(false);
  });

  it("leaves URLs untouched for default themes", () => {
    expect(appendOverlayThemeToUrl("/overlay/tok", {})).toBe("/overlay/tok");
  });

  it("appends ?theme= (or &theme= when a query exists)", () => {
    const theme: OverlayTheme = { accent: "#ffd166" };
    const encoded = encodeOverlayTheme(theme);
    expect(appendOverlayThemeToUrl("/overlay/tok", theme)).toBe(
      `/overlay/tok?theme=${encoded}`,
    );
    expect(appendOverlayThemeToUrl("/overlay/tok?w=session", theme)).toBe(
      `/overlay/tok?w=session&theme=${encoded}`,
    );
  });
});

describe("themeToCssVars", () => {
  it("returns an empty object for the default theme (zero overrides)", () => {
    expect(themeToCssVars({})).toEqual({});
    expect(themeToCssVars({ scale: 1, radius: "rounded" })).toEqual({});
  });

  it("emits accent + derived halo/rim vars", () => {
    const vars = themeToCssVars({ accent: "#ffd166" });
    expect(vars["--ov-accent"]).toBe("#ffd166");
    expect(vars["--ov-halo"]).toBe("rgba(255,209,102,0.22)");
    expect(vars["--ov-rim"]).toBe("rgba(255,209,102,0.12)");
  });

  it("expands 3-digit accents when deriving rgba values", () => {
    const vars = themeToCssVars({ accent: "#fff" });
    expect(vars["--ov-halo"]).toBe("rgba(255,255,255,0.22)");
  });

  it("emits the panel gradient with the clamped opacity", () => {
    const vars = themeToCssVars({ opacity: 0.5 });
    expect(vars["--ov-panel-bg"]).toBe(
      "linear-gradient(135deg, rgba(11,13,18,0.5) 0%, rgba(22,26,35,0.5) 100%)",
    );
    expect(themeToCssVars({ opacity: 42 })["--ov-panel-bg"]).toContain(
      "rgba(11,13,18,1)",
    );
  });

  it("maps radius, scale and font through fixed tables", () => {
    expect(themeToCssVars({ radius: "sharp" })["--ov-radius"]).toBe("2px");
    expect(themeToCssVars({ radius: "pill" })["--ov-radius"]).toBe("26px");
    expect(themeToCssVars({ scale: 1.25 })["--ov-scale"]).toBe("1.25");
    expect(themeToCssVars({ font: "mono" })["--ov-font"]).toContain(
      "monospace",
    );
    expect(themeToCssVars({ font: "condensed" })["--ov-font"]).toContain(
      "Arial Narrow",
    );
  });

  it("never emits vars for tokens that fail validation", () => {
    const vars = themeToCssVars({
      accent: "</style>",
      scale: 7 as never,
      radius: "wavy" as never,
      font: "papyrus" as never,
    });
    expect(vars).toEqual({});
  });
});

describe("contrast math", () => {
  it("black on white is 21:1, self-contrast is 1:1", () => {
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#fff", "#fff")).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#3ec0c7", "#10141a")).toBeCloseTo(
      contrastRatio("#10141a", "#3ec0c7") as number,
      10,
    );
  });

  it("returns null for invalid colours", () => {
    expect(contrastRatio("red", "#fff")).toBeNull();
    expect(relativeLuminance("nope")).toBeNull();
    expect(accentContrastOnPanel("</style>")).toBeNull();
  });

  it("flags dark-on-dark accents below 3:1", () => {
    const ratio = accentContrastOnPanel("#112233");
    expect(ratio).not.toBeNull();
    expect(ratio as number).toBeLessThan(3);
  });

  it("panel reference is a valid hex", () => {
    expect(relativeLuminance(OVERLAY_PANEL_REFERENCE_HEX)).not.toBeNull();
  });
});

describe("presets", () => {
  it("ships the five required presets", () => {
    expect(OVERLAY_THEME_PRESETS.map((p) => p.id)).toEqual([
      "default",
      "midnight",
      "high-contrast",
      "minimal-glass",
      "retro-terminal",
    ]);
  });

  it("every preset survives normalization unchanged (already canonical)", () => {
    for (const preset of OVERLAY_THEME_PRESETS) {
      expect(normalizeOverlayTheme(preset.theme)).toEqual(preset.theme);
    }
  });

  it("every preset accent clears the 3:1 broadcast-readability bar", () => {
    for (const preset of OVERLAY_THEME_PRESETS) {
      const accent = preset.theme.accent ?? DEFAULT_OVERLAY_ACCENT;
      const ratio = accentContrastOnPanel(accent);
      expect(ratio, `${preset.id} accent ${accent}`).not.toBeNull();
      expect(ratio as number, `${preset.id} accent ${accent}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("expandHex", () => {
  it("expands #rgb and lowercases #rrggbb", () => {
    expect(expandHex("#3EC")).toBe("#33eecc");
    expect(expandHex("#FFD166")).toBe("#ffd166");
  });

  it("passes invalid values through untouched (caller validates)", () => {
    expect(expandHex("nope")).toBe("nope");
  });
});
