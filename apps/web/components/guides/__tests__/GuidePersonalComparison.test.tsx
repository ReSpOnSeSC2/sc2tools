import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuideMePayload } from "@/lib/guides/types";

const harness = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: false },
  api: { data: undefined as GuideMePayload | undefined, error: undefined as unknown, isLoading: false },
  useApi: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/guides/pvz/stargate-into-glaives",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => harness.auth }));
vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string) => {
    harness.useApi(path);
    return { ...harness.api, mutate: harness.mutate };
  },
}));

import { GuidePersonalComparison } from "@/components/guides/GuidePersonalComparison";
import { FIXTURE_BUILD_PUBLISHED, FIXTURE_ME } from "@/lib/guides/__fixtures__";
import { BuildTimingsSection } from "@/components/guides/build/BuildTimingsSection";

const COMMUNITY = (FIXTURE_BUILD_PUBLISHED.timings?.milestones ?? []).map(({ key, label, event, median }) => ({
  key,
  label,
  event,
  median,
}));

async function renderComparison() {
  const view = render(
    <GuidePersonalComparison
      matchupSlug="pvz"
      buildSlug="stargate-into-glaives"
      buildName="Stargate into Glaives"
      community={COMMUNITY}
    />,
  );
  await act(async () => { await vi.dynamicImportSettled(); });
  return view;
}

afterEach(() => {
  cleanup();
  harness.auth = { isLoaded: true, isSignedIn: false };
  harness.api = { data: undefined, error: undefined, isLoading: false };
  harness.useApi.mockReset();
  harness.mutate.mockReset();
  vi.unstubAllEnvs();
});

describe("GuidePersonalComparison", () => {
  it("retains the Try CTA beside a real populated timings table without duplicating sign-in copy", () => {
    vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", "all");
    render(<BuildTimingsSection payload={FIXTURE_BUILD_PUBLISHED} blurb={[]} />);
    expect(screen.getAllByRole("link", { name: "Sign in to see your own timings next to these" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "analyze your replays in your browser — no download" }).getAttribute("href")).toContain("focus=pvz%2Fstargate-into-glaives");
    expect(harness.useApi).not.toHaveBeenCalled();
  });

  it.each(["off", "admins"])("hides the public Try CTA in%s mode", (mode) => {
    vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", mode);
    render(<BuildTimingsSection payload={FIXTURE_BUILD_PUBLISHED} blurb={[]} />);
    expect(screen.queryByRole("link", { name: "analyze your replays in your browser — no download" })).toBeNull();
    expect(harness.useApi).not.toHaveBeenCalled();
  });
  it("asks signed-out visitors to sign in and makes no request", async () => {
    await renderComparison();
    const link = screen.getByRole("link", { name: "Sign in to see your own timings next to these" });
    expect(link.getAttribute("href")).toBe("/sign-in?redirect_url=%2Fguides%2Fpvz%2Fstargate-into-glaives");
    expect(harness.useApi).not.toHaveBeenCalled();
  });

  it("offers the win-rate comparison when the build has no community timings yet", async () => {
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
    await act(async () => { await vi.dynamicImportSettled(); });
    const box = screen.getByTestId("guide-me");
    expect(box.querySelector("p")?.textContent).toBe(`You: ${((FIXTURE_ME.winRate ?? Number.NaN) * 100).toFixed(1)}% over 37 games`);
    expect(screen.getByRole("link", { name: "See all your builds" }).getAttribute("href")).toBe("/app/builds");
  });

  it("shows the signed-in viewer's own record next to the community medians", async () => {
    harness.auth = { isLoaded: true, isSignedIn: true };
    harness.api = { data: FIXTURE_ME, error: undefined, isLoading: false };
    await renderComparison();
    expect(harness.useApi).toHaveBeenCalledWith("/v1/guides/me/pvz/stargate-into-glaives");
    const box = screen.getByTestId("guide-me");
    expect(box.textContent).toContain("You: 48.6% over 37 games");
    // Twilight Council: yours 292 s = 4:52, community median 290 s = 4:50.
    expect(box.textContent).toContain("Median Twilight Council started 4:52 (community 4:50)");
    expect(box.textContent).toContain("Median Resonating Glaives done 7:27 (community 7:21)");
  });

  it("handles loading and a viewer with no games on this build", async () => {
    harness.auth = { isLoaded: true, isSignedIn: true };
    harness.api = { data: undefined, error: undefined, isLoading: true };
    const { rerender } = await renderComparison();
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

  it("shows the community delta and leaves timing comparison to the table", async () => {
    harness.auth = { isLoaded: true, isSignedIn: true }; harness.api = { data: FIXTURE_ME, error: undefined, isLoading: false };
    render(<GuidePersonalComparison matchupSlug="pvz" buildSlug="stargate-into-glaives" buildName="Stargate into Glaives" community={COMMUNITY} communityWinRate={0.55} showTimings={false} />);
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(screen.getByText("You: 48.6% over 37 games · community 55.0% (−6.4 pp)")).toBeTruthy(); expect(screen.queryByRole("list")).toBeNull();
  });

  it("retries a failed request and announces the pending retry", async () => {
    harness.auth = { isLoaded: true, isSignedIn: true }; harness.api = { data: undefined, error: { status: 503, message: "Busy" }, isLoading: false };
    let finish!: () => void; harness.mutate.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    await renderComparison(); const retry = await screen.findByRole("button", { name: "Retry" }); fireEvent.click(retry); expect(harness.mutate).toHaveBeenCalledTimes(1); expect(retry.getAttribute("aria-busy")).toBe("true"); await act(async () => finish());
  });

  it("handles a mid-session 401 as signed out and omits a delta for undecided games", async () => {
    harness.auth = { isLoaded: true, isSignedIn: true }; harness.api = { data: undefined, error: { status: 401 }, isLoading: false };
    const view = await renderComparison(); expect(screen.getByRole("link", { name: "Sign in to see your own timings next to these" })).toBeTruthy(); expect(screen.queryByRole("alert")).toBeNull();
    harness.api = { data: { ...FIXTURE_ME, wins: 0, losses: 0, winRate: null, timings: { samples: 0, milestones: [] } }, error: undefined, isLoading: false };
    view.rerender(<GuidePersonalComparison matchupSlug="pvz" buildSlug="stargate-into-glaives" buildName="Stargate into Glaives" community={COMMUNITY} communityWinRate={0.55} />); expect(screen.getByText("You: 37 games, no decided games yet")).toBeTruthy(); expect(screen.queryByText(/community 55/)).toBeNull();
  });
});
