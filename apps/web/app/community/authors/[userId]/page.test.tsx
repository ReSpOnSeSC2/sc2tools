import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The author page tells a missing or private profile (API 404) apart
 * from an outage (API unreachable or 5xx). All data is synthetic.
 */
const mocks = vi.hoisted(() => ({ getJsonWithStatus: vi.fn() }));

vi.mock("@/lib/serverApi", () => ({ getJsonWithStatus: mocks.getJsonWithStatus }));
vi.mock("@/components/community/AuthorProfile", () => ({
  AuthorProfile: ({ profile }: { profile: { displayName: string } }) => <h1>{profile.displayName}</h1>,
}));

import CommunityAuthorPage, { generateMetadata } from "@/app/community/authors/[userId]/page";

const params = () => Promise.resolve({ userId: "u_fixture" });

afterEach(() => {
  cleanup();
  mocks.getJsonWithStatus.mockReset();
});

describe("/community/authors/[userId]", () => {
  it("keeps the neutral private-or-missing copy for a 404", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: null, status: 404 });
    render(await CommunityAuthorPage({ params: params() }));
    expect(screen.getByText("This profile is private or doesn't exist")).toBeTruthy();
    expect(screen.queryByText(/temporarily unavailable/)).toBeNull();
    expect((await generateMetadata({ params: params() })).robots).toEqual({ index: false, follow: false });
  });

  it.each([null, 500])("shows the unavailable panel with noindex when the API answers %s", async (status) => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: null, status });
    render(await CommunityAuthorPage({ params: params() }));
    expect(screen.getByRole("heading", { level: 1, name: "This profile is temporarily unavailable" })).toBeTruthy();
    expect(screen.queryByText("This profile is private or doesn't exist")).toBeNull();
    expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href")).toBe("/community/authors/u_fixture");
    expect(screen.getByRole("link", { name: "Back to community" }).getAttribute("href")).toBe("/community");
    const metadata = await generateMetadata({ params: params() });
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.title).toBe("This profile is temporarily unavailable — SC2 Tools");
  });

  it("renders a public profile", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({
      data: { displayName: "Fixture Author", totalBuilds: 2 },
      status: 200,
    });
    render(await CommunityAuthorPage({ params: params() }));
    expect(screen.getByRole("heading", { name: "Fixture Author" })).toBeTruthy();
    const metadata = await generateMetadata({ params: params() });
    expect(metadata.robots).toBeUndefined();
    expect(metadata.description).toBe("2 published builds by Fixture Author.");
  });
});
