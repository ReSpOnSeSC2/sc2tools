import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuideMePayload } from "@/lib/guides/types";

const harness = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: false },
  api: { data: undefined as GuideMePayload | undefined, error: undefined as unknown, isLoading: false },
  useApi: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => harness.auth }));
vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string) => {
    harness.useApi(path);
    return harness.api;
  },
}));

import { GuidePersonalComparison } from "@/components/guides/GuidePersonalComparison";
import { FIXTURE_BUILD_PUBLISHED, FIXTURE_ME } from "@/lib/guides/__fixtures__";

const COMMUNITY = (FIXTURE_BUILD_PUBLISHED.timings?.milestones ?? []).map(({ key, label, event, median }) => ({
  key,
  label,
  event,
  median,
}));

function renderComparison() {
  return render(
    <GuidePersonalComparison
      matchupSlug="pvz"
      buildSlug="stargate-into-glaives"
      buildName="Stargate into Glaives"
      community={COMMUNITY}
    />,
  );
}

afterEach(() => {
  cleanup();
  harness.auth = { isLoaded: true, isSignedIn: false };
  harness.api = { data: undefined, error: undefined, isLoading: false };
  harness.useApi.mockReset();
});

describe("GuidePersonalComparison", () => {
  it("asks signed-out visitors to sign in and makes no request", () => {
    renderComparison();
    const link = screen.getByRole("link", { name: "Sign in to compare your timings" });
    expect(link.getAttribute("href")).toBe("/sign-in");
    expect(harness.useApi).not.toHaveBeenCalled();
  });

  it("offers the win-rate comparison when the build has no community timings yet", () => {
    render(
      <GuidePersonalComparison matchupSlug="pvz" buildSlug="stargate-into-glaives" buildName="Stargate into Glaives" community={[]} />,
    );
    expect(screen.getByRole("link", { name: "Sign in to compare your win rate" })).toBeTruthy();
    cleanup();
    harness.auth = { isLoaded: true, isSignedIn: true };
    harness.api = { data: FIXTURE_ME, error: undefined, isLoading: false };
    render(
      <GuidePersonalComparison matchupSlug="pvz" buildSlug="stargate-into-glaives" buildName="Stargate into Glaives" community={[]} />,
    );
    const box = screen.getByTestId("guide-me");
    expect(box.textContent).toBe(`You: ${((FIXTURE_ME.winRate ?? Number.NaN) * 100).toFixed(1)}% over 37 games`);
  });

  it("shows the signed-in viewer's own record next to the community medians", () => {
    harness.auth = { isLoaded: true, isSignedIn: true };
    harness.api = { data: FIXTURE_ME, error: undefined, isLoading: false };
    renderComparison();
    expect(harness.useApi).toHaveBeenCalledWith("/v1/guides/me/pvz/stargate-into-glaives");
    const box = screen.getByTestId("guide-me");
    expect(box.textContent).toContain("You: 48.6% over 37 games");
    // Twilight Council: yours 292 s = 4:52, community median 290 s = 4:50.
    expect(box.textContent).toContain("Median Twilight Council started 4:52 (community 4:50)");
    expect(box.textContent).toContain("Median Resonating Glaives done 7:27 (community 7:21)");
  });

  it("handles loading and a viewer with no games on this build", () => {
    harness.auth = { isLoaded: true, isSignedIn: true };
    harness.api = { data: undefined, error: undefined, isLoading: true };
    const { rerender } = renderComparison();
    expect(screen.getByText("Loading your numbers…")).toBeTruthy();
    harness.api = {
      data: { ...FIXTURE_ME, games: 0, wins: 0, losses: 0, winRate: null, timings: { samples: 0, milestones: [] } },
      error: undefined,
      isLoading: false,
    };
    rerender(
      <GuidePersonalComparison
        matchupSlug="pvz"
        buildSlug="stargate-into-glaives"
        buildName="Stargate into Glaives"
        community={COMMUNITY}
      />,
    );
    expect(screen.getByText(/You haven't played Stargate into Glaives with 12 starting workers yet/)).toBeTruthy();
  });
});
