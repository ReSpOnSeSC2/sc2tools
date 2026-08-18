import { describe, expect, it } from "vitest";
import {
  classifyAvailability,
  describeVoice,
  explainResolution,
  inferVoiceGender,
  resolveVoice,
  usableVoices,
  voiceEngine,
} from "@/lib/voiceCatalog";

/** Minimal stand-in — the module only reads these fields. */
function v(
  name: string,
  lang: string,
  opts: { local?: boolean; isDefault?: boolean } = {},
): SpeechSynthesisVoice {
  return {
    name,
    lang,
    localService: opts.local ?? true,
    default: opts.isDefault ?? false,
    voiceURI: name,
  } as SpeechSynthesisVoice;
}

/**
 * The Windows/Chrome inventory that produced the original bug report:
 * Google network voices sitting alongside the local SAPI set, with the
 * male David flagged as the engine default.
 */
const CHROME_ON_WINDOWS = [
  v("Google UK English Female", "en-GB", { local: false }),
  v("Google UK English Male", "en-GB", { local: false }),
  v("Google US English", "en-US", { local: false }),
  v("Microsoft David - English (United States)", "en-US", { isDefault: true }),
  v("Microsoft Zira - English (United States)", "en-US"),
  v("Microsoft Mark - English (United States)", "en-US"),
  v("Microsoft Hazel - English (United Kingdom)", "en-GB"),
  v("Microsoft George - English (United Kingdom)", "en-GB"),
];

/** What the same machine looks like from inside the OBS Browser Source. */
const OBS_CEF_ON_WINDOWS = CHROME_ON_WINDOWS.filter((x) => x.localService);

describe("inferVoiceGender", () => {
  it("reads an explicit gender out of the label", () => {
    expect(inferVoiceGender("Google UK English Female")).toBe("female");
    expect(inferVoiceGender("Google UK English Male")).toBe("male");
  });

  it("recognises the Windows SAPI given names", () => {
    expect(inferVoiceGender("Microsoft Zira - English (United States)")).toBe(
      "female",
    );
    expect(inferVoiceGender("Microsoft David - English (United States)")).toBe(
      "male",
    );
    expect(inferVoiceGender("Microsoft Hazel Desktop")).toBe("female");
  });

  it("recognises Edge natural and macOS voices", () => {
    expect(inferVoiceGender("Microsoft Aria Online (Natural)")).toBe("female");
    expect(inferVoiceGender("Microsoft Guy Online (Natural)")).toBe("male");
    expect(inferVoiceGender("Samantha")).toBe("female");
    expect(inferVoiceGender("Alex")).toBe("male");
  });

  it("does not guess when the name says nothing", () => {
    expect(inferVoiceGender("Google US English")).toBe("neutral");
    expect(inferVoiceGender(undefined)).toBe("neutral");
  });

  it("does not false-positive on names embedding a known token", () => {
    // "Denmark" contains "mark"; only whole words should match.
    expect(inferVoiceGender("Microsoft Danish Denmark")).toBe("neutral");
  });
});

describe("classifyAvailability", () => {
  it("marks Google network voices as Chrome-only", () => {
    expect(
      classifyAvailability({
        name: "Google UK English Female",
        localService: false,
      }),
    ).toBe("chromeOnly");
  });

  it("marks Google voices Chrome-only even when localService lies", () => {
    // Some Chromium builds mis-report these as local; the name wins.
    expect(
      classifyAvailability({
        name: "Google UK English Female",
        localService: true,
      }),
    ).toBe("chromeOnly");
  });

  it("marks Edge online/natural voices as Chrome-only", () => {
    expect(
      classifyAvailability({
        name: "Microsoft Aria Online (Natural) - English (United States)",
        localService: false,
      }),
    ).toBe("chromeOnly");
  });

  it("marks local SAPI voices as portable", () => {
    expect(
      classifyAvailability({
        name: "Microsoft Zira - English (United States)",
        localService: true,
      }),
    ).toBe("portable");
  });
});

describe("usableVoices", () => {
  it("drops everything that cannot speak inside OBS", () => {
    expect(usableVoices(CHROME_ON_WINDOWS).map((x) => x.name)).toEqual([
      "Microsoft David - English (United States)",
      "Microsoft Zira - English (United States)",
      "Microsoft Mark - English (United States)",
      "Microsoft Hazel - English (United Kingdom)",
      "Microsoft George - English (United Kingdom)",
    ]);
  });
});

describe("resolveVoice", () => {
  it("returns the exact pick when it is installed", () => {
    const r = resolveVoice(CHROME_ON_WINDOWS, {
      name: "Google UK English Female",
      lang: "en-GB",
      gender: "female",
    });
    expect(r.reason).toBe("exact");
    expect(r.substituted).toBe(false);
    expect(r.voice?.name).toBe("Google UK English Female");
  });

  it("REGRESSION: a female pick never degrades to the male default", () => {
    // The reported bug. Inside OBS the Google voice is gone and David
    // is flagged default; the old code handed back David.
    const r = resolveVoice(OBS_CEF_ON_WINDOWS, {
      name: "Google UK English Female",
      lang: "en-GB",
      gender: "female",
    });
    expect(r.reason).toBe("genderMatch");
    expect(r.substituted).toBe(true);
    expect(r.voice?.name).toBe("Microsoft Hazel - English (United Kingdom)");
    expect(inferVoiceGender(r.voice!.name)).toBe("female");
  });

  it("holds gender for a male pick too", () => {
    const r = resolveVoice(OBS_CEF_ON_WINDOWS, {
      name: "Google UK English Male",
      lang: "en-GB",
      gender: "male",
    });
    expect(r.voice?.name).toBe("Microsoft George - English (United Kingdom)");
  });

  it("infers gender from the name when prefs predate the gender field", () => {
    const r = resolveVoice(OBS_CEF_ON_WINDOWS, {
      name: "Google UK English Female",
      lang: "en-GB",
    });
    expect(r.reason).toBe("genderMatch");
    expect(r.voice?.name).toBe("Microsoft Hazel - English (United Kingdom)");
  });

  it("falls back across locales within the same base language", () => {
    // No en-GB female installed: en-US Zira is the nearest female.
    const catalog = [
      v("Microsoft David - English (United States)", "en-US", {
        isDefault: true,
      }),
      v("Microsoft Zira - English (United States)", "en-US"),
    ];
    const r = resolveVoice(catalog, {
      name: "Google UK English Female",
      lang: "en-GB",
      gender: "female",
    });
    expect(r.reason).toBe("genderMatch");
    expect(r.voice?.name).toBe("Microsoft Zira - English (United States)");
  });

  it("drops to a language match when no same-gender voice exists", () => {
    const catalog = [
      v("Microsoft David - English (United States)", "en-US", {
        isDefault: true,
      }),
      v("Microsoft Mark - English (United States)", "en-US"),
    ];
    const r = resolveVoice(catalog, {
      name: "Google UK English Female",
      lang: "en-GB",
      gender: "female",
    });
    expect(r.reason).toBe("langMatch");
    expect(r.substituted).toBe(true);
    expect(r.voice?.name).toBe("Microsoft David - English (United States)");
  });

  it("leaves the engine default alone when nothing matches the language", () => {
    const r = resolveVoice([v("Microsoft Hedda - German", "de-DE")], {
      name: "Google UK English Female",
      lang: "en-GB",
      gender: "female",
    });
    expect(r.reason).toBe("engineDefault");
    expect(r.voice).toBeNull();
  });

  it("reports an empty catalog distinctly so callers can retry", () => {
    const r = resolveVoice([], { name: "Microsoft Zira", lang: "en-US" });
    expect(r.reason).toBe("catalogEmpty");
  });

  it("returns no preference when nothing was picked", () => {
    const r = resolveVoice(CHROME_ON_WINDOWS, undefined);
    expect(r.reason).toBe("noPreference");
    expect(r.voice).toBeNull();
  });

  it("tolerates label case and whitespace drift between engines", () => {
    const r = resolveVoice(
      [v("Microsoft  ZIRA - English (United States)", "en-US")],
      {
        name: "Microsoft Zira - English (United States)",
        lang: "en-US",
        gender: "female",
      },
    );
    expect(r.reason).toBe("normalized");
    expect(r.substituted).toBe(false);
  });

  it("prefers a local voice over a network one at the same tier", () => {
    const catalog = [
      v("Microsoft Aria Online (Natural)", "en-US", { local: false }),
      v("Microsoft Zira - English (United States)", "en-US"),
    ];
    const r = resolveVoice(catalog, {
      name: "Google UK English Female",
      lang: "en-US",
      gender: "female",
    });
    expect(r.voice?.name).toBe("Microsoft Zira - English (United States)");
  });
});

describe("voiceEngine / describeVoice", () => {
  it("names the engine family", () => {
    expect(voiceEngine("Google UK English Female")).toBe("Google");
    expect(voiceEngine("Microsoft Zira")).toBe("Microsoft");
    expect(voiceEngine("Samantha")).toBe("Other");
  });

  it("annotates the gender in the picker label", () => {
    expect(
      describeVoice(v("Microsoft Zira - English (United States)", "en-US")),
    ).toBe("Microsoft Zira - English (United States) - female");
    expect(describeVoice(v("Google US English", "en-US"))).toBe(
      "Google US English",
    );
  });
});

describe("explainResolution", () => {
  it("says nothing when the exact pick is playing", () => {
    const wish = { name: "Microsoft Zira", lang: "en-US" };
    expect(
      explainResolution(
        resolveVoice([v("Microsoft Zira", "en-US")], wish),
        wish,
      ),
    ).toBeNull();
  });

  it("names the substitute when one was made", () => {
    const wish = {
      name: "Google UK English Female",
      lang: "en-GB",
      gender: "female" as const,
    };
    const msg = explainResolution(resolveVoice(OBS_CEF_ON_WINDOWS, wish), wish);
    expect(msg).toContain("Microsoft Hazel");
    expect(msg).toContain("isn't available here");
  });
});
