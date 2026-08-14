import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  statsError: null as { status: number; message: string } | null,
  statsLoading: false,
  stats: {
    items: [{ publicSlug: "public-build", total: 41, wins: 25, losses: 16 }],
  } as { items: Array<{ publicSlug: string; total: number; wins: number; losses: number }> } | undefined,
  paths: [] as Array<string | null>,
  configs: [] as unknown[],
}));

vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string | null, config?: unknown) => {
    harness.paths.push(path);
    harness.configs.push(config);
    if (path === "/v1/community/my-build-stats") {
      return {
        data: harness.stats,
        error: harness.statsError,
        isLoading: harness.statsLoading,
      };
    }
    return { data: undefined };
  },
}));

import { CommunityOwnerReplayCount } from "../CommunityOwnerReplayCount";

afterEach(() => {
  cleanup();
  harness.statsError = null;
  harness.statsLoading = false;
  harness.stats = {
    items: [{ publicSlug: "public-build", total: 41, wins: 25, losses: 16 }],
  };
  harness.paths.length = 0;
  harness.configs.length = 0;
});

describe("CommunityOwnerReplayCount", () => {
  it("shows an authenticated creator their private classified total", () => {
    render(
      <CommunityOwnerReplayCount
        publicSlug="public-build"
        ownerUserId="owner-1"
      />,
    );

    expect(screen.getByText("41 classified replays")).toBeTruthy();
    expect(harness.paths).toContain("/v1/community/my-build-stats");
    expect(harness.configs).toContainEqual({
      refreshInterval: 15_000,
      revalidateOnFocus: true,
    });
  });

  it("hides private state until owner membership resolves", () => {
    harness.stats = undefined;
    harness.statsLoading = true;

    render(
      <CommunityOwnerReplayCount
        publicSlug="public-build"
        ownerUserId="owner-1"
      />,
    );

    expect(screen.queryByRole("status")).toBeNull();
    expect(harness.paths).toContain("/v1/community/my-build-stats");
  });

  it("hides private state when owner stats fail", () => {
    harness.stats = undefined;
    harness.statsError = { status: 503, message: "Busy" };

    render(
      <CommunityOwnerReplayCount
        publicSlug="public-build"
        ownerUserId="owner-1"
      />,
    );

    expect(screen.queryByText("Temporarily unavailable")).toBeNull();
  });

  it("shows an explicit zero for a matching owner row", () => {
    harness.stats = {
      items: [{ publicSlug: "public-build", total: 0, wins: 0, losses: 0 }],
    };

    render(
      <CommunityOwnerReplayCount
        publicSlug="public-build"
        ownerUserId="owner-1"
      />,
    );

    expect(screen.getByText("0 classified replays")).toBeTruthy();
  });

  it("uses owner-only membership and exposes no total to another viewer", () => {
    harness.stats = { items: [] };
    render(
      <CommunityOwnerReplayCount
        publicSlug="public-build"
        ownerUserId="owner-1"
      />,
    );

    expect(screen.queryByText(/classified replay/)).toBeNull();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.queryByText("Temporarily unavailable")).toBeNull();
    expect(harness.paths).toContain("/v1/community/my-build-stats");
  });

  it("hides user A's private total immediately when the account changes", () => {
    const view = render(
      <CommunityOwnerReplayCount
        publicSlug="public-build"
        ownerUserId="owner-1"
      />,
    );
    expect(screen.getByText("41 classified replays")).toBeTruthy();

    harness.paths.length = 0;
    harness.stats = { items: [] };
    view.rerender(
      <CommunityOwnerReplayCount
        publicSlug="public-build"
        ownerUserId="owner-1"
      />,
    );

    expect(screen.queryByText("41 classified replays")).toBeNull();
    expect(harness.paths).toContain("/v1/community/my-build-stats");
  });

  it("does not expose private states while the current viewer is unresolved", () => {
    harness.stats = undefined;

    render(
      <CommunityOwnerReplayCount
        publicSlug="public-build"
        ownerUserId="owner-1"
      />,
    );

    expect(screen.queryByText(/classified replay/)).toBeNull();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(harness.paths).toContain("/v1/community/my-build-stats");
  });
});
