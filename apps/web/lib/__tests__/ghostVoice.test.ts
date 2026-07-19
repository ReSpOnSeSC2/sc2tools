import { describe, expect, it } from "vitest";
import {
  appendGhostVoiceToUrl,
  catchUpIndex,
  ghostVoiceEnabledFromSearch,
  ghostVoiceLine,
  nextSpeakIndex,
  spokenStepName,
} from "../ghostVoice";
import type { GhostStep } from "../ghostBuild";

const STEPS: GhostStep[] = [
  { t: 20, supply: 14, name: "Pylon" },
  { t: 40, supply: 16, name: "Gateway" },
  { t: 65, supply: 17, name: "CyberneticsCore" },
];

describe("ghostVoice", () => {
  it("appends voice=1 before the #ghost fragment", () => {
    expect(
      appendGhostVoiceToUrl("https://x.test/w/ghost-build?theme=t#ghost=abc", true),
    ).toBe("https://x.test/w/ghost-build?theme=t&voice=1#ghost=abc");
    expect(appendGhostVoiceToUrl("https://x.test/w/ghost-build", true)).toBe(
      "https://x.test/w/ghost-build?voice=1",
    );
    // Off leaves the URL untouched.
    expect(appendGhostVoiceToUrl("https://x.test/w?theme=t", false)).toBe(
      "https://x.test/w?theme=t",
    );
  });

  it("reads the flag from a search string", () => {
    expect(ghostVoiceEnabledFromSearch("?theme=t&voice=1")).toBe(true);
    expect(ghostVoiceEnabledFromSearch("?voice=0")).toBe(false);
    expect(ghostVoiceEnabledFromSearch("")).toBe(false);
  });

  it("speaks supply + spaced name", () => {
    expect(ghostVoiceLine(STEPS[2])).toBe("17 — Cybernetics Core");
    expect(ghostVoiceLine({ t: 5, supply: null, name: "Pylon" })).toBe("Pylon");
    expect(spokenStepName("SpawningPool")).toBe("Spawning Pool");
  });

  it("nextSpeakIndex fires 5s before target, in order, once", () => {
    // 20s step becomes speakable at 15.
    expect(nextSpeakIndex(STEPS, 14, -1)).toBeNull();
    expect(nextSpeakIndex(STEPS, 15, -1)).toBe(0);
    // Already spoken → next step not yet due.
    expect(nextSpeakIndex(STEPS, 15, 0)).toBeNull();
    expect(nextSpeakIndex(STEPS, 35, 0)).toBe(1);
    // Past the end.
    expect(nextSpeakIndex(STEPS, 999, 2)).toBeNull();
  });

  it("catchUpIndex skips a stale backlog to the last due step", () => {
    // Rejoin at 62s: steps 0 and 1 long past, step 2 due at 60.
    expect(catchUpIndex(STEPS, 62, -1)).toBe(2);
    // Fresh game start: nothing due yet.
    expect(catchUpIndex(STEPS, 0, -1)).toBe(-1);
  });
});
