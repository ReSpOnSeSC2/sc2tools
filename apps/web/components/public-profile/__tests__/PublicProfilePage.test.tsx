import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PublicProfile } from "../PublicProfile";
import type { PublicPlayerProfile } from "../types";

// next/image needs the Next runtime; a bare <img> is equivalent here.
vi.mock("next/image", () => ({
  default: (props: { src?: string; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={String(props.src ?? "")} alt={props.alt ?? ""} />
  ),
}));

// notFound() throws a tagged sentinel we can assert on.
vi.mock("next/navigation", () => ({
  notFound: () => {
    const err = new Error("NEXT_NOT_FOUND");
    (err as unknown as { digest: string }).digest = "NEXT_NOT_FOUND";
    throw err;
  },
}));

const getJsonMock = vi.fn();
vi.mock("@/lib/serverApi", () => ({
  getJson: (...args: unknown[]) => getJsonMock(...args),
}));

// Imported after the mocks are declared so the page picks them up.
import PublicProfilePage, { generateMetadata } from "@/app/p/[handle]/page";

const PROFILE: PublicPlayerProfile = {
  handle: "u_a",
  displayName: "Reaver",
  mainRace: "Protoss",
  joinedAt: "2026-01-01T00:00:00.000Z",
  totals: { games: 5, wins: 3, losses: 2, winRate: 0.6 },
  matchups: [
    { matchup: "vs T", games: 3, wins: 2, losses: 1, winRate: 2 / 3 },
    { matchup: "vs Z", games: 2, wins: 1, losses: 1, winRate: 0.5 },
  ],
  signatureBuilds: [
    { name: "PvT - Glaive Adept Timing", games: 3, wins: 2, losses: 1, winRate: 2 / 3 },
  ],
  featuredBuild: {
    slug: "glaive-timing-abc123",
    title: "Glaive Adept Timing",
    matchup: "PvT",
    votes: 7,
  },
  publishedBuildCount: 1,
};

afterEach(() => {
  cleanup();
  getJsonMock.mockReset();
});

describe("PublicProfile (presentational)", () => {
  test("renders name, headline stats, matchup splits, and the viral CTA", () => {
    render(<PublicProfile profile={PROFILE} />);
    expect(screen.getByText("Reaver")).toBeTruthy();
    expect(screen.getByText("vs T")).toBeTruthy();
    expect(screen.getByText("PvT - Glaive Adept Timing")).toBeTruthy();
    // The "get your own" conversion CTA is the point of the page.
    expect(screen.getByText(/get yours at sc2tools\.com/i)).toBeTruthy();
  });

  test("carries no opponent identity fields (only aggregates are passed in)", () => {
    const { container } = render(<PublicProfile profile={PROFILE} />);
    // The component's prop surface has no place to put opponent tags, but
    // guard against a regression that starts echoing raw handles. Match a
    // battle-tag-shaped token (alnum immediately before "#…digits"); inline
    // hex win-rate colours (":#28914b") never satisfy that, so they don't
    // trip the check.
    expect(container.innerHTML).not.toMatch(/[A-Za-z0-9]#\d{3,}/);
  });
});

describe("PublicProfilePage (SSR data flow)", () => {
  beforeEach(() => getJsonMock.mockReset());

  test("renders the profile when the API returns one", async () => {
    getJsonMock.mockResolvedValue({ profile: PROFILE });
    const ui = await PublicProfilePage({
      params: Promise.resolve({ handle: "u_a" }),
    });
    render(ui);
    expect(screen.getByText("Reaver")).toBeTruthy();
    expect(getJsonMock).toHaveBeenCalledWith("/v1/public/profile/u_a");
  });

  test("calls notFound() when the profile is private / missing", async () => {
    getJsonMock.mockResolvedValue(null);
    await expect(
      PublicProfilePage({ params: Promise.resolve({ handle: "u_private" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  test("calls notFound() when the API returns an empty envelope", async () => {
    getJsonMock.mockResolvedValue({});
    await expect(
      PublicProfilePage({ params: Promise.resolve({ handle: "u_a" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("generateMetadata", () => {
  beforeEach(() => getJsonMock.mockReset());

  test("indexable, name-bearing metadata for a public profile", async () => {
    getJsonMock.mockResolvedValue({ profile: PROFILE });
    const md = await generateMetadata({
      params: Promise.resolve({ handle: "u_a" }),
    });
    expect(String(md.title)).toContain("Reaver");
    expect(md.alternates?.canonical).toBe("/p/u_a");
    // Not marked noindex → crawlable.
    expect(md.robots).toBeUndefined();
  });

  test("noindex, neutral metadata for a private / missing profile", async () => {
    getJsonMock.mockResolvedValue(null);
    const md = await generateMetadata({
      params: Promise.resolve({ handle: "u_private" }),
    });
    expect(md.robots).toMatchObject({ index: false });
    expect(md.alternates?.canonical).toBe("/p/u_private");
    // Wording must not reveal whether the handle exists.
    expect(String(md.description)).toMatch(/private or doesn't exist/i);
  });
});
