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

// The page uses the status-aware fetch so a genuine API 404 (missing/
// private) can 404 while an unreachable API renders a transient
// "unavailable" state instead. Mock resolves {data, status} envelopes.
const getJsonWithStatusMock = vi.fn();
vi.mock("@/lib/serverApi", () => ({
  getJsonWithStatus: (...args: unknown[]) => getJsonWithStatusMock(...args),
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
  getJsonWithStatusMock.mockReset();
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
  beforeEach(() => getJsonWithStatusMock.mockReset());

  test("renders the profile when the API returns one", async () => {
    getJsonWithStatusMock.mockResolvedValue({
      data: { profile: PROFILE },
      status: 200,
    });
    const ui = await PublicProfilePage({
      params: Promise.resolve({ handle: "u_a" }),
    });
    render(ui);
    expect(screen.getByText("Reaver")).toBeTruthy();
    expect(getJsonWithStatusMock).toHaveBeenCalledWith(
      "/v1/public/profile/u_a",
    );
  });

  test("calls notFound() when the API positively 404s (private / missing)", async () => {
    getJsonWithStatusMock.mockResolvedValue({ data: null, status: 404 });
    await expect(
      PublicProfilePage({ params: Promise.resolve({ handle: "u_private" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  test("calls notFound() when the API returns an empty envelope", async () => {
    getJsonWithStatusMock.mockResolvedValue({ data: {}, status: 200 });
    await expect(
      PublicProfilePage({ params: Promise.resolve({ handle: "u_a" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  test("renders the transient unavailable state (NOT a 404) when the API is unreachable", async () => {
    getJsonWithStatusMock.mockResolvedValue({ data: null, status: null });
    const ui = await PublicProfilePage({
      params: Promise.resolve({ handle: "u_a" }),
    });
    render(ui);
    expect(screen.getByText(/temporarily unavailable/i)).toBeTruthy();
  });
});

describe("generateMetadata", () => {
  beforeEach(() => getJsonWithStatusMock.mockReset());

  test("indexable, name-bearing metadata for a public profile", async () => {
    getJsonWithStatusMock.mockResolvedValue({
      data: { profile: PROFILE },
      status: 200,
    });
    const md = await generateMetadata({
      params: Promise.resolve({ handle: "u_a" }),
    });
    expect(String(md.title)).toContain("Reaver");
    expect(md.alternates?.canonical).toBe("/p/u_a");
    // Not marked noindex → crawlable.
    expect(md.robots).toBeUndefined();
  });

  test("throws notFound() pre-stream for a private / missing profile (real 404 status)", async () => {
    // Raising in generateMetadata (before the loading.tsx Suspense
    // boundary starts streaming) is what makes the response a genuine
    // 404 instead of a soft-404 with a 200 status.
    getJsonWithStatusMock.mockResolvedValue({ data: null, status: 404 });
    await expect(
      generateMetadata({ params: Promise.resolve({ handle: "u_private" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  test("noindex, neutral metadata when the API is unreachable", async () => {
    getJsonWithStatusMock.mockResolvedValue({ data: null, status: null });
    const md = await generateMetadata({
      params: Promise.resolve({ handle: "u_a" }),
    });
    expect(md.robots).toMatchObject({ index: false });
    expect(md.alternates?.canonical).toBe("/p/u_a");
    expect(String(md.description)).toMatch(/unavailable right now/i);
  });
});
