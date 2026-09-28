import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchGuideMatchup: vi.fn() }));
vi.mock("@/lib/guides/api", () => ({ fetchGuideMatchup: mocks.fetchGuideMatchup }));

import { CommunityGuideLink } from "@/components/guides/CommunityGuideLink";
import { communityGuideMatchup, findCommunityGuide } from "@/lib/guides/communityGuide";
import { FIXTURE_MATCHUP } from "@/lib/guides/__fixtures__";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "on");
  mocks.fetchGuideMatchup.mockResolvedValue({ kind: "ok", data: FIXTURE_MATCHUP });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  mocks.fetchGuideMatchup.mockReset();
});

async function renderLink(matchup: string | undefined, names: unknown[]) {
  return render(<>{await CommunityGuideLink({ matchup, names })}</>);
}

describe("findCommunityGuide (exact names only)", () => {
  it("matches the catalog or display name, trimmed and case-insensitive", () => {
    expect(findCommunityGuide(FIXTURE_MATCHUP, ["  pvz - stargate INTO glaives "])).toEqual({
      buildSlug: "stargate-into-glaives",
      name: "Stargate into Glaives",
    });
    expect(findCommunityGuide(FIXTURE_MATCHUP, [undefined, "Stargate into Glaives"])?.buildSlug).toBe(
      "stargate-into-glaives",
    );
  });

  it("never fuzzy-matches and never links an unpublished guide", () => {
    expect(findCommunityGuide(FIXTURE_MATCHUP, ["Stargate into Glaive"])).toBeNull();
    expect(findCommunityGuide(FIXTURE_MATCHUP, ["My Stargate into Glaives"])).toBeNull();
    // Carrier Rush is below the publishing floor in the fixture.
    expect(findCommunityGuide(FIXTURE_MATCHUP, ["PvZ - Carrier Rush"])).toBeNull();
    expect(findCommunityGuide(FIXTURE_MATCHUP, ["", "   ", null])).toBeNull();
  });

  it("canonicalises only real 1v1 matchups", () => {
    expect(communityGuideMatchup(" pvz ")).toBe("PvZ");
    expect(communityGuideMatchup("TVT")).toBe("TvT");
    expect(communityGuideMatchup("PvX")).toBeNull();
    expect(communityGuideMatchup(undefined)).toBeNull();
  });
});

describe("CommunityGuideLink", () => {
  it("links the canonical guide for an exact name in the same matchup", async () => {
    await renderLink("PvZ", ["Stargate into Glaives", "My build"]);
    const link = screen.getByRole("link", { name: "Read the community guide" });
    expect(link.getAttribute("href")).toBe("/guides/pvz/stargate-into-glaives");
    expect(mocks.fetchGuideMatchup).toHaveBeenCalledWith("pvz");
  });

  it("renders nothing without an exact match, when the API is down or guides are off", async () => {
    const { container } = await renderLink("PvZ", ["Stargate into Glaive"]);
    expect(container.innerHTML).toBe("");
    cleanup();

    mocks.fetchGuideMatchup.mockResolvedValue({ kind: "unavailable" });
    expect((await renderLink("PvZ", ["Stargate into Glaives"])).container.innerHTML).toBe("");
    cleanup();

    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "");
    mocks.fetchGuideMatchup.mockClear();
    expect((await renderLink("PvZ", ["Stargate into Glaives"])).container.innerHTML).toBe("");
    expect(mocks.fetchGuideMatchup).not.toHaveBeenCalled();
  });

  it("never asks the API for a non-1v1 matchup", async () => {
    expect((await renderLink("any", ["Stargate into Glaives"])).container.innerHTML).toBe("");
    expect(mocks.fetchGuideMatchup).not.toHaveBeenCalled();
  });
});
