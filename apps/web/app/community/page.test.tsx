import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * /community tells an outage (API unreachable or failing) apart from a
 * real empty list. Client children are stubbed; all data is synthetic.
 */
const mocks = vi.hoisted(() => ({ getJsonWithStatus: vi.fn() }));

vi.mock("@/lib/serverApi", () => ({ getJsonWithStatus: mocks.getJsonWithStatus }));
vi.mock("@/components/Banner", () => ({ Banner: () => null }));
vi.mock("@/components/community/PublishCta", () => ({ PublishCta: () => <span>Publish fixture</span> }));
vi.mock("@/components/community/LazyMyPublishedBuilds", () => ({ LazyMyPublishedBuilds: () => <p>Owner-only publications</p> }));
vi.mock("@/components/community/CommunityFilterBar", () => ({ CommunityFilterBar: ({ initialRace, initialVs }: { initialRace: string; initialVs: string }) => <div data-testid="community-filters" data-race={initialRace} data-vs={initialVs} /> }));
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
  it("keeps Mine private and skips every public server fetch", async () => {
    render(await CommunityPage({ searchParams: search({ mine: "1", race: "P", q: "old" }) }));
    expect(screen.getByText("Owner-only publications")).toBeTruthy();
    expect(mocks.getJsonWithStatus).not.toHaveBeenCalled();
    expect((await generateMetadata({ searchParams: search({ mine: "1" }) })).robots).toEqual({ index: false, follow: false });
    expect(mocks.getJsonWithStatus).not.toHaveBeenCalled();
  });
  it.each([null, 502])("says builds are temporarily unavailable (noindex) when the API answers %s", async (status) => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: null, status });
    render(await CommunityPage({ searchParams: search({ matchup: "PvZ", sort: "new" }) }));
    expect(screen.getByRole("heading", { name: "Community builds are temporarily unavailable" })).toBeTruthy();
    expect(screen.queryByText(/Be the first/)).toBeNull();
    expect(screen.queryByText(/No builds yet/)).toBeNull();
    // Try again reloads the same filtered view.
    expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href")).toBe("/community?race=P&vs=Z&sort=new");
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

  it("preserves every filter in paging links and explains the current page", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: { items: [{ slug: "build-a", title: "Fixture opener" }], total: 120, hasMore: true }, status: 200 });
    render(await CommunityPage({ searchParams: search({ race: "Z", vs: "T", skill: "diamond", sort: "updated", q: "roach", offset: "24" }) }));
    const nav = screen.getByRole("navigation", { name: "Pagination" }); expect(within(nav).getByText("Page 2 of 5")).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Next →" }).getAttribute("href")).toBe("/community?race=Z&vs=T&skill=diamond&sort=updated&q=roach&offset=48");
    expect(within(nav).getByRole("link", { name: "← Previous" }).getAttribute("href")).toBe("/community?race=Z&vs=T&skill=diamond&sort=updated&q=roach");
    expect(mocks.getJsonWithStatus).toHaveBeenCalledWith("/v1/community/builds?race=Z&vsRace=T&skill=diamond&sort=updated&q=roach&limit=24&offset=24");
  });

  it.each([{ offset: "0", hasMore: true, disabled: "← Previous" }, { offset: "96", hasMore: false, disabled: "Next →" }])("renders disabled ends as non-focusable text ($disabled)", async ({ offset, hasMore, disabled }) => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: { items: [{ slug: "build-a", title: "Fixture opener" }], total: 100, hasMore }, status: 200 });
    render(await CommunityPage({ searchParams: search({ offset }) })); const nav = screen.getByRole("navigation", { name: "Pagination" });
    expect(within(nav).queryByRole("link", { name: disabled })).toBeNull();
    const label = within(nav).getByText(disabled); expect(label.tagName).toBe("SPAN"); expect(label.getAttribute("aria-disabled")).toBe("true"); expect(label.tabIndex).toBe(-1);
  });

  it("explains a page past the end and returns to page one with its filters", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: { items: [], total: 2, hasMore: false }, status: 200 });
    render(await CommunityPage({ searchParams: search({ race: "P", sort: "new", offset: "24" }) }));
    expect(screen.getByText("No more results")).toBeTruthy(); expect(screen.getByText("This page is past the end of the list.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to page 1" }).getAttribute("href")).toBe("/community?race=P&sort=new");
    expect(screen.queryByText(/Be the first/)).toBeNull(); expect(screen.queryByText("No builds yet")).toBeNull();
  });

  it("names active filters in a real empty result and clears them while retaining sort", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: { items: [], total: 0, hasMore: false }, status: 200 });
    render(await CommunityPage({ searchParams: search({ race: "Z", vs: "T", skill: "diamond", sort: "updated" }) }));
    expect(screen.getByText("No Zerg builds vs Terran at Diamond yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Reset filters" }).getAttribute("href")).toBe("/community?sort=updated");
    expect(screen.getByRole("link", { name: "Clear all" }).getAttribute("href")).toBe("/community?sort=updated");
  });

  it("maps a legacy matchup URL to race controls and keeps the community canonical", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: { items: [], total: 0, hasMore: false }, status: 200 });
    render(await CommunityPage({ searchParams: search({ matchup: "PvZ" }) }));
    expect(screen.getByTestId("community-filters").dataset).toMatchObject({ race: "P", vs: "Z" });
    expect(mocks.getJsonWithStatus).toHaveBeenCalledWith("/v1/community/builds?race=P&vsRace=Z&sort=top&limit=24&offset=0");
    expect((await generateMetadata({ searchParams: search({ matchup: "PvZ" }) })).alternates?.canonical).toBe("/community");
  });
});
