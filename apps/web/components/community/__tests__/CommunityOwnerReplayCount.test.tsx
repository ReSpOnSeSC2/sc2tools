import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommunityOwnerReplayCount } from "../CommunityOwnerReplayCount";
import { ownerBuildsRefreshInterval } from "../useOwnerBuilds";

const h = vi.hoisted(() => ({ data: { items: [{ slug: "public-build", total: 12, wins: 8, losses: 4 }] } as { items: Array<{ slug: string; total: number; wins: number; losses: number }> } | undefined, error: null as null | Error, loading: false, useApi: vi.fn() }));
vi.mock("@/lib/clientApi", () => ({ useApi: (...args: unknown[]) => { h.useApi(...args); return { data: h.data, error: h.error, isLoading: h.loading }; } }));
beforeEach(() => { h.data = { items: [{ slug: "public-build", total: 12, wins: 8, losses: 4 }] }; h.error = null; h.loading = false; h.useApi.mockClear(); });
afterEach(cleanup);

describe("creator-only build record", () => {
  it("formats games, decided record and percentage using the shared tone", () => {
    const { container } = render(<CommunityOwnerReplayCount publicSlug="public-build" />);
    expect(container.textContent).toBe("12 games · 8–4 · 67%");
    expect(screen.getByText("· 67%").getAttribute("style")).toContain("color");
    expect(h.useApi).toHaveBeenCalledWith("/v1/community/my-builds", { refreshInterval: ownerBuildsRefreshInterval, revalidateOnFocus: true });
  });
  it("does not make up a percentage when no game has a decided result", () => {
    h.data = { items: [{ slug: "public-build", total: 2, wins: 0, losses: 0 }] };
    const { container } = render(<CommunityOwnerReplayCount publicSlug="public-build" />); expect(container.textContent).toBe("2 games · 0–0");
  });
  it("explains a verified zero without an empty percentage", () => {
    h.data = { items: [{ slug: "public-build", total: 0, wins: 0, losses: 0 }] };
    render(<CommunityOwnerReplayCount publicSlug="public-build" />); expect(screen.getByText("No games with this build yet")).toBeTruthy();
  });
  it("hides state until ownership resolves and hides another viewer's record", () => {
    h.data = undefined; h.loading = true; const view = render(<CommunityOwnerReplayCount publicSlug="public-build" />);
    expect(view.container.textContent).toBe(""); expect(screen.queryByRole("status")).toBeNull();
    h.data = { items: [] }; view.rerender(<CommunityOwnerReplayCount publicSlug="public-build" />); expect(view.container.textContent).toBe("");
  });
  it("shows a skeleton only for an already verified owner's loading record", () => {
    h.loading = true; render(<CommunityOwnerReplayCount publicSlug="public-build" />);
    expect(screen.getByRole("status", { name: "Loading your build record" }).querySelector('[aria-hidden="true"]')).toBeTruthy(); expect(screen.queryByText("Loading…")).toBeNull();
  });
  it("never reveals a former account's total after its scoped data disappears", () => {
    const view = render(<CommunityOwnerReplayCount publicSlug="public-build" />); expect(view.container.textContent).toContain("12 games");
    h.data = undefined; h.error = new Error("Busy"); view.rerender(<CommunityOwnerReplayCount publicSlug="public-build" />); expect(view.container.textContent).toBe("");
  });
  it("stops polling for viewers who have no publications", () => {
    expect(ownerBuildsRefreshInterval()).toBe(0); expect(ownerBuildsRefreshInterval({ items: [] })).toBe(0);
    expect(ownerBuildsRefreshInterval({ items: [{} as never] })).toBe(15000);
  });
});
