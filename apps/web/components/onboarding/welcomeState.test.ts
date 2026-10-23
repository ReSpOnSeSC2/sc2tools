import { describe, expect, it } from "vitest";
import { completedWelcomeSteps, isWelcomeStep, nextWelcomeStep, previousWelcomeStep, resumeWelcomeStep } from "./welcomeState";

describe("resumable welcome path", () => {
  it("resumes from server completion rather than local assumptions", () => {
    expect(resumeWelcomeStep({ agentPaired: false, games: { total: 0 } })).toBe("welcome");
    expect(resumeWelcomeStep({ agentPaired: true, games: { total: 0 } })).toBe("import");
    expect(resumeWelcomeStep({ agentPaired: false, games: { total: 1 } })).toBe("done");
    expect(isWelcomeStep("done")).toBe(true); expect(isWelcomeStep("unknown")).toBe(false);
  });
  it("keeps Back and Continue on the path actually chosen", () => {
    expect(previousWelcomeStep("import", true)).toBe("download");
    expect(previousWelcomeStep("import", false)).toBe("pair");
    expect(nextWelcomeStep("download", true)).toBe("import");
    expect(nextWelcomeStep("download", false)).toBe("pair");
    expect(nextWelcomeStep("done", true)).toBe("done");
  });
  it("marks an existing paired PC complete without claiming browser imports paired one", () => {
    expect(completedWelcomeSteps("import", true)).toContain("pair");
    expect(completedWelcomeSteps("import", false)).not.toContain("pair");
    expect(completedWelcomeSteps("import", false)).toEqual(["welcome", "download"]);
    expect(completedWelcomeSteps("done", false)).not.toContain("pair");
  });
});
