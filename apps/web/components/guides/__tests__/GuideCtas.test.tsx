import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gaEvent: vi.fn(),
  arm: vi.fn(() => true),
}));

vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: mocks.gaEvent }));
vi.mock("@/lib/ghostBuild", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ghostBuild")>();
  return { ...actual, armGhostTargetForMatchup: mocks.arm };
});

import { GuideCtas } from "@/components/guides/GuideCtas";
import { buildGhostTargetFromGuide } from "@/lib/guides/ghost";
import { FIXTURE_BUILD_PUBLISHED } from "@/lib/guides/__fixtures__";
import { isSettingsTabId } from "@/components/analyzer/settings/SettingsShell";

/** jsdom cannot navigate; stop anchor default actions (onClick handlers still run). */
function preventNavigation(event: Event) {
  event.preventDefault();
}

beforeEach(() => document.addEventListener("click", preventNavigation, true));

afterEach(() => {
  document.removeEventListener("click", preventNavigation, true);
  cleanup();
  mocks.gaEvent.mockReset();
  mocks.arm.mockReset();
  mocks.arm.mockReturnValue(true);
});

const TARGET = buildGhostTargetFromGuide(FIXTURE_BUILD_PUBLISHED);

function renderCtas(ghostTarget = TARGET) {
  return render(
    <GuideCtas matchup="PvZ" buildSlug="stargate-into-glaives" matchupPath="/guides/pvz" ghostTarget={ghostTarget} />,
  );
}

describe("GuideCtas", () => {
  it("links sign-up and the matchup page and fires gaEvent for each", () => {
    renderCtas();
    const track = screen.getByRole("link", { name: /Track your win rate with this build — free/ });
    expect(track.getAttribute("href")).toBe("/sign-up");
    fireEvent.click(track);
    expect(mocks.gaEvent).toHaveBeenCalledWith("guide_cta_click", {
      cta: "track",
      matchup: "PvZ",
      build: "stargate-into-glaives",
    });
    const matchup = screen.getByRole("link", { name: /See what's winning/ });
    expect(matchup.getAttribute("href")).toBe("/guides/pvz");
    fireEvent.click(matchup);
    expect(mocks.gaEvent).toHaveBeenLastCalledWith("guide_cta_click", {
      cta: "matchup",
      matchup: "PvZ",
      build: "stargate-into-glaives",
    });
  });

  it("arms the community Ghost Build and points to overlay settings", async () => {
    expect(TARGET).not.toBeNull();
    renderCtas();
    fireEvent.click(screen.getByRole("button", { name: /Practice it on stream/ }));
    await waitFor(() => expect(mocks.arm).toHaveBeenCalledTimes(1));
    expect(mocks.arm).toHaveBeenCalledWith("P", "Z", TARGET);
    expect(mocks.gaEvent).toHaveBeenCalledWith("guide_cta_click", {
      cta: "practice",
      matchup: "PvZ",
      build: "stargate-into-glaives",
    });
    const settings = await screen.findByRole("link", { name: /Open Settings → Overlay/ });
    expect(settings.getAttribute("href")).toBe("/settings?tab=overlay");
    // /settings opens a tab only from ?tab= (never the hash), so it must name a real tab.
    const tab = new URL(settings.getAttribute("href") ?? "", "https://sc2tools.com").searchParams.get("tab");
    expect(isSettingsTabId(tab)).toBe(true);
  });

  it("reports a storage failure instead of claiming success", async () => {
    mocks.arm.mockReturnValue(false);
    renderCtas();
    fireEvent.click(screen.getByRole("button", { name: /Practice it on stream/ }));
    expect(await screen.findByText(/Couldn't save the Ghost Build here/)).toBeTruthy();
  });

  it("hides the practice CTA without a target", () => {
    renderCtas(null);
    expect(screen.queryByRole("button", { name: /Practice it on stream/ })).toBeNull();
  });
});
