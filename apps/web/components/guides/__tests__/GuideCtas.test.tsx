import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gaEvent: vi.fn(),
  auth: { isLoaded: true, isSignedIn: false },
  practice: null as null | Record<string, unknown>,
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: mocks.gaEvent }));
vi.mock("@/components/practice/PracticeButton", () => ({ PracticeButton: (props: { matchup: string; onPractice: () => void }) => { mocks.practice = props; return <button onClick={props.onPractice}>Practice in {props.matchup}</button>; } }));

import { GuideCtas } from "@/components/guides/GuideCtas";
import { buildGhostTargetFromGuide } from "@/lib/guides/ghost";
import { FIXTURE_BUILD_PUBLISHED } from "@/lib/guides/__fixtures__";

/** jsdom cannot navigate; stop anchor default actions (onClick handlers still run). */
function preventNavigation(event: Event) {
  event.preventDefault();
}

beforeEach(() => document.addEventListener("click", preventNavigation, true));

afterEach(() => {
  document.removeEventListener("click", preventNavigation, true);
  cleanup();
  mocks.auth = { isLoaded: true, isSignedIn: false };
  mocks.gaEvent.mockReset();
  mocks.practice = null;
});

const TARGET = buildGhostTargetFromGuide(FIXTURE_BUILD_PUBLISHED);

function renderCtas(ghostTarget = TARGET) {
  return render(
    <GuideCtas matchup="PvZ" buildSlug="stargate-into-glaives" matchupPath="/guides/pvz" ghostTarget={ghostTarget} />,
  );
}

describe("GuideCtas", () => {
  it("points signed-in players to their record and builds", () => {
    mocks.auth = { isLoaded: true, isSignedIn: true };
    renderCtas();
    expect(screen.getByRole("link", { name: "See your record with this build" }).getAttribute("href")).toBe("#your-record");
    expect(screen.getByRole("link", { name: "Open my builds" }).getAttribute("href")).toBe("/app/builds");
    expect(screen.queryByRole("link", { name: /Track your win rate/ })).toBeNull();
  });

  it("preserves the visitor CTA while authentication loads", () => {
    mocks.auth = { isLoaded: false, isSignedIn: false };
    renderCtas();
    expect(screen.getByRole("link", { name: /Track your win rate/ }).getAttribute("href")).toBe("/sign-up");
  });
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

  it("delegates the guide target to the shared synced Practice action and retains analytics", async () => {
    renderCtas(); fireEvent.click(await screen.findByRole("button", { name: "Practice in PvZ" }));
    expect(mocks.practice).toMatchObject({ matchup: "PvZ", target: TARGET });
    expect(mocks.gaEvent).toHaveBeenCalledWith("guide_cta_click", { cta: "practice", matchup: "PvZ", build: "stargate-into-glaives" });
  });

  it("hides the practice CTA without a target", () => {
    renderCtas(null);
    expect(screen.queryByRole("button", { name: /Practice in PvZ/ })).toBeNull();
  });
});
