import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * /community tells an outage (API unreachable or failing) apart from a
 * real empty list. Client children are stubbed; all data is synthetic.
 */
const mocks = vi.hoisted(() => ({ getJsonWithStatus: vi.fn() }));

vi.mock("@/lib/serverApi", () => ({ getJsonWithStatus: mocks.getJsonWithStatus }));
vi.mock("@/components/Banner", () => ({ Banner: () => null }));
vi.mock("@/components/community/CommunityFilterBar", () => ({ CommunityFilterBar: () => null }));
vi.mock("@/components/community/CommunityShell", () => ({
  CommunityShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/community/CommunityBuildCard", () => ({
  CommunityBuildCard: ({ build }: { build: { title: string } }) => <span>{build.title}</span>,
}));

import CommunityPage, { generateMetadata } from "@/app/community/page";

const search = (sp: Record<string, string> = {}) => Promise.resolve(sp);

afterEach(() => {
  cleanup();
  mocks.getJsonWithStatus.mockReset();
});

describe("/community", () => {
  it.each([null, 502])("says builds are temporarily unavailable (noindex) when the API answers %s", async (status) => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: null, status });
    render(await CommunityPage({ searchParams: search({ matchup: "PvZ", sort: "new" }) }));
    expect(screen.getByRole("heading", { name: "Community builds are temporarily unavailable" })).toBeTruthy();
    expect(screen.queryByText(/Be the first/)).toBeNull();
    expect(screen.queryByText(/No builds yet/)).toBeNull();
    // Try again reloads the same filtered view.
    expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href")).toBe("/community?matchup=PvZ&sort=new");
    const metadata = await generateMetadata({ searchParams: search() });
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it("keeps 'Be the first' for a real empty list, and stays indexable", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: { items: [], total: 0, hasMore: false }, status: 200 });
    render(await CommunityPage({ searchParams: search() }));
    expect(screen.getByText("No builds yet")).toBeTruthy();
    expect(screen.getByText("Be the first to publish a build to the community.")).toBeTruthy();
    expect(screen.queryByText(/temporarily unavailable/)).toBeNull();
    expect((await generateMetadata({ searchParams: search() })).robots).toBeUndefined();
  });

  it("lists published builds", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({
      data: { items: [{ slug: "build-a", title: "Fixture opener", votes: 1 }], total: 1, hasMore: false },
      status: 200,
    });
    render(await CommunityPage({ searchParams: search() }));
    expect(screen.getByText("Fixture opener")).toBeTruthy();
    expect(mocks.getJsonWithStatus).toHaveBeenCalledWith("/v1/community/builds?sort=top&limit=24&offset=0");
  });
});
