import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GetYourOwnCTA } from "../GetYourOwnCTA";

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe("public player analysis CTA", () => {
  it.each(["off", "admins", "all"])("keeps the public %s rollout destination on the shared link button", mode => {
    vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", mode);
    render(<GetYourOwnCTA />);
    const link = screen.getByRole("link", { name: mode === "all" ? "Analyze your replays free" : "Get yours at sc2tools.com" });
    expect(link.getAttribute("href")).toBe(mode === "all" ? "/try?utm_source=player&utm_medium=link&utm_campaign=instant" : "/");
    expect(link.className).toContain("hard-press");
    expect(link.className).toContain("focus-visible:ring-2");
  });
});
