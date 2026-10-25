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

  it.each([null, 500])("throws for API outage %s to preserve last-good ISR output", async (status) => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: null, status });
    await expect(CommunityAuthorPage({ params: params() })).rejects.toThrow("This profile is temporarily unavailable");
    await expect(generateMetadata({ params: params() })).rejects.toThrow("This profile is temporarily unavailable");
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
