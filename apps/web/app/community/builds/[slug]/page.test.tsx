import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The community build page's server-side wiring: the breadcrumb JSON-LD
 * carries the author-written title, so it must be escaped (a title
 * containing "</script>" must never close the tag), the page asks
 * CommunityGuideLink about this build's matchup and names, and a build is
 * read back the way it is matched (rules as Must have / Must not have,
 * never a "×1" step for an At most 0 rule). Interactive child components
 * are stubbed. All data is synthetic test fixture data.
 */
const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  guideLinkProps: [] as Array<{ matchup: string | undefined; names: ReadonlyArray<unknown> }>,
  timelineCalls: 0,
  saveProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/serverApi", () => ({ getJson: mocks.getJson }));
vi.mock("@/components/guides/CommunityGuideLink", () => ({
  CommunityGuideLink: (props: { matchup: string | undefined; names: ReadonlyArray<unknown> }) => {
    mocks.guideLinkProps.push(props);
    return null;
  },
}));
vi.mock("@/components/community/AuthorChip", () => ({ AuthorChip: () => null }));
vi.mock("@/components/community/CommunityBuildSignatureTimeline", () => ({
  CommunityBuildSignatureTimeline: () => {
    mocks.timelineCalls += 1;
    return null;
  },
}));
vi.mock("@/components/community/CommunityVotePanel", () => ({ CommunityVotePanel: () => null }));
vi.mock("@/components/community/CommunityBuildOwnerControls", () => ({
  CommunityBuildOwnerControls: () => null,
}));
vi.mock("@/components/community/RelatedBuilds", () => ({ RelatedBuilds: () => null }));
vi.mock("@/components/community/SaveToLibraryButton", () => ({
  SaveToLibraryButton: (props: Record<string, unknown>) => {
    mocks.saveProps.push(props);
    return null;
  },
}));
vi.mock("@/components/community/ShareLinkButton", () => ({ ShareLinkButton: () => null }));

import CommunityBuildPage from "@/app/community/builds/[slug]/page";

const HOSTILE_TITLE = 'Fixture opener</script><script>window.__pwned = 1</script><!--';

const RULES = [
  { type: "before", name: "BuildStargate", time_lt: 240 },
  { type: "count_max", name: "BuildRoboticsFacility", count: 0, time_lt: 360 },
  { type: "not_before", name: "BuildTwilightCouncil", time_lt: 300 },
];

function detail(title: string, build: Record<string, unknown> = {}) {
  return {
    slug: "build-fixture0001",
    title,
    description: "Synthetic fixture build.",
    matchup: "PvZ",
    votes: 0,
    publishedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    build: { name: "PvZ - Stargate into Glaives", race: "Protoss", ...build },
  };
}

async function renderPage(title: string, build?: Record<string, unknown>) {
  mocks.getJson.mockResolvedValue(detail(title, build));
  const page = await CommunityBuildPage({ params: Promise.resolve({ slug: "build-fixture0001" }) });
  return render(page);
}

/** A rules group's rows as plain text. */
function groupRows(title: string): string[] {
  const section = screen.getByRole("heading", { name: title }).closest("section");
  if (!section) throw new Error(`no ${title} section`);
  return within(section)
    .getAllByRole("listitem")
    .map((li) => (li.textContent ?? "").replace(/\s+/g, " ").trim());
}

afterEach(() => {
  cleanup();
  mocks.getJson.mockReset();
  mocks.guideLinkProps.length = 0;
  mocks.timelineCalls = 0;
  mocks.saveProps.length = 0;
});

describe("/community/builds/[slug]", () => {
  it("escapes the author's title inside the breadcrumb JSON-LD", async () => {
    const { container } = await renderPage(HOSTILE_TITLE);
    const scripts = container.querySelectorAll('script[type="application/ld+json"]');
    expect(scripts).toHaveLength(1);
    const raw = scripts[0].innerHTML;
    expect(raw.toLowerCase()).not.toContain("</script");
    expect(raw).not.toContain("<");
    const parsed = JSON.parse(raw) as { itemListElement: Array<{ name: string }> };
    expect(parsed.itemListElement[1].name).toBe(HOSTILE_TITLE);
  });

  it("offers the canonical guide lookup this build's matchup and names", async () => {
    await renderPage("Glaive adepts into macro");
    expect(mocks.guideLinkProps).toEqual([
      { matchup: "PvZ", names: ["PvZ - Stargate into Glaives", "Glaive adepts into macro"] },
    ]);
  });

  it("reads a rule-only build back as Must have / Must not have, not as steps", async () => {
    await renderPage("Glaive Adepts", { rules: RULES });
    expect(screen.getByRole("heading", { name: "Build order" })).toBeTruthy();
    expect(groupRows("Must have")).toEqual(["At least 1 Stargate before 4:00"]);
    expect(groupRows("Must not have")).toEqual([
      "No Twilight Council before 5:00",
      "No Robotics Facility before 6:00",
    ]);
    expect(mocks.timelineCalls).toBe(0);
  });

  it("prefers the rules a build is matched on over a v2 signature", async () => {
    await renderPage("Both shapes", {
      rules: RULES,
      signature: [{ unit: "Stargate", count: 1, beforeSec: 240 }],
    });
    expect(screen.getByRole("heading", { name: "Must have" })).toBeTruthy();
    expect(mocks.timelineCalls).toBe(0);
  });

  it("keeps the step timeline for signature-only builds", async () => {
    await renderPage("Signature only", {
      signature: [{ unit: "Stargate", count: 1, beforeSec: 240 }],
    });
    expect(mocks.timelineCalls).toBe(1);
    expect(screen.queryByRole("heading", { name: "Must have" })).toBeNull();
  });

  it("shows the author's game plan, and hides it when every list is empty", async () => {
    await renderPage("With a plan", {
      rules: RULES,
      winConditions: ["Kill the third"],
      losesTo: ["Early Roach pressure"],
      transitionsInto: [],
    });
    expect(screen.getByRole("heading", { name: "Game plan" })).toBeTruthy();
    expect(screen.getByText("Early Roach pressure")).toBeTruthy();
    cleanup();
    await renderPage("No plan", { rules: RULES, winConditions: [], losesTo: [""] });
    expect(screen.queryByRole("heading", { name: "Game plan" })).toBeNull();
  });

  it("puts the skill level in the header, or nothing when it isn't set", async () => {
    await renderPage("Diamond build", { rules: RULES, skillLevel: "diamond" });
    expect(screen.getByText("Diamond")).toBeTruthy();
    cleanup();
    await renderPage("No level", { rules: RULES, skillLevel: null });
    expect(screen.queryByText("Diamond")).toBeNull();
  });

  it("never renders an Author notes card (notes are not public)", async () => {
    await renderPage("Notes leak check", { rules: RULES, notes: "private scouting notes" });
    expect(screen.queryByText("Author notes")).toBeNull();
    expect(screen.queryByText("private scouting notes")).toBeNull();
  });

  it("hands Save to my library the public slug and version", async () => {
    await renderPage("Saveable", { rules: RULES });
    expect(mocks.saveProps[0]).toMatchObject({
      communitySlug: "build-fixture0001",
      version: "2026-09-10T00:00:00.000Z",
      title: "Saveable",
    });
  });
});
