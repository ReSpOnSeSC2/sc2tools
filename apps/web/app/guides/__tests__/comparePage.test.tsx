import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_BUILD_PUBLISHED } from "@/lib/guides/__fixtures__";
import type { GuideMilestone } from "@/lib/guides/types";

const mocks = vi.hoisted(() => ({
  fetchGuideBuild: vi.fn(),
  fetchPublishedGuidePaths: vi.fn(),
  redirect: vi.fn((path: string) => { throw new Error("redirect " + path); }),
}));
vi.mock("@/lib/guides/api", () => ({
  fetchGuideBuild: mocks.fetchGuideBuild,
  fetchPublishedGuidePaths: mocks.fetchPublishedGuidePaths,
}));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/guides/pvz/compare",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));

import ComparePage, { dynamic, generateMetadata } from "@/app/guides/[matchup]/compare/page";

function props(builds?: string, era?: string) {
  return { params: Promise.resolve({ matchup: "pvz" }), searchParams: Promise.resolve({ builds, era }) };
}

function milestone(key: string, median: number): GuideMilestone {
  return { key, label: key, event: "start", games: 10, users: 5, presence: 0.8, p25: median - 10, median, p75: median + 10 };
}

const a = { ...FIXTURE_BUILD_PUBLISHED, buildSlug: "alpha", name: "Alpha", timings: { samples: 10, users: 5, milestones: [milestone("Pylon", 20), milestone("Gateway", 60)] } };
const b = { ...a, buildSlug: "bravo", name: "Bravo", timings: { samples: 10, users: 5, milestones: [milestone("Pylon", 18), milestone("Cybernetics Core", 90)] } };
const c = { ...a, buildSlug: "charlie", name: "Charlie" };

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "1");
  mocks.fetchPublishedGuidePaths.mockResolvedValue(new Set(["alpha", "bravo", "charlie", "delta"].map((slug) => "/guides/pvz/" + slug)));
  mocks.fetchGuideBuild.mockImplementation(async (_matchup, slug: string) =>
    ({ kind: "ok", data: [a, b, c].find((build) => build.buildSlug === slug) }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe("compare published openers", () => {
  it("sets noindex, follow and the matchup canonical", async () => {
    expect(dynamic).toBe("force-dynamic");
    const md = await generateMetadata(props("alpha,bravo"));
    expect(md.robots).toEqual({ index: false, follow: true });
    expect(md.alternates?.canonical).toBe("/guides/pvz");
  });

  it.each(["alpha", "alpha,alpha", "alpha,unknown", "alpha,unpublished", "alpha,https://example.com"])(
    "shows the picker state for %s", async (query) => {
      render(await ComparePage(props(query)));
      expect(screen.getByText("Pick 2–3 openers to compare")).toBeTruthy();
      expect(mocks.fetchGuideBuild).not.toHaveBeenCalled();
    },
  );

  it("deduplicates, caps and preserves URL order, with union timing rows", async () => {
    render(await ComparePage(props("bravo,bravo,alpha,charlie,delta")));
    expect(screen.getByText("Showing the first 3 openers.")).toBeTruthy();
    expect(screen.getAllByTestId("compare-opener").map((column) => within(column).getByRole("heading").textContent))
      .toEqual(["Bravo", "Alpha", "Charlie"]);
    expect(mocks.fetchGuideBuild.mock.calls.map((args) => args[1])).toEqual(["bravo", "alpha", "charlie"]);
    const timings = within(screen.getByRole("table", { name: "Key timings" }));
    expect(timings.getAllByRole("rowheader").map((row) => row.textContent)).toEqual(["Pylon started", "Cybernetics Core started", "Gateway started"]);
    const pylon = within(timings.getByRole("row", { name: /Pylon/ })).getAllByRole("cell");
    expect(pylon[0].textContent).toContain("earliest");
    expect(pylon[1].textContent).not.toContain("earliest");
    expect(screen.getByRole("link", { name: "Remove Alpha" }).getAttribute("href")).toBe("/guides/pvz/compare?builds=bravo,charlie");
  });

  it("renders a retry state only for the column that fails", async () => {
    mocks.fetchGuideBuild.mockImplementation(async (_matchup, slug: string) => {
      if (slug === "alpha") throw new Error("unavailable");
      return { kind: "ok", data: b };
    });
    render(await ComparePage(props("alpha,bravo")));
    const [failed, available] = screen.getAllByTestId("compare-opener");
    expect(within(failed).getByText("This opener is temporarily unavailable")).toBeTruthy();
    expect(within(failed).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(within(available).getByRole("link", { name: "Read the full guide" })).toBeTruthy();
  });

  it("returns the archived view to the 12-worker matchup", async () => {
    await expect(ComparePage(props("alpha,bravo", "before"))).rejects.toThrow("redirect /guides/pvz");
    expect(mocks.fetchPublishedGuidePaths).not.toHaveBeenCalled();
  });
});
