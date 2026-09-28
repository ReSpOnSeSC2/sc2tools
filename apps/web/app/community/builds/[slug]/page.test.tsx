import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The community build page's server-side wiring: the breadcrumb JSON-LD
 * carries the author-written title, so it must be escaped (a title
 * containing "</script>" must never close the tag), and the page asks
 * CommunityGuideLink about this build's matchup and names. Child client
 * components are stubbed; only the page's own markup is under test.
 * All data is synthetic test fixture data.
 */
const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  guideLinkProps: [] as Array<{ matchup: string | undefined; names: ReadonlyArray<unknown> }>,
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
  CommunityBuildSignatureTimeline: () => null,
}));
vi.mock("@/components/community/CommunityVotePanel", () => ({ CommunityVotePanel: () => null }));
vi.mock("@/components/community/CommunityBuildOwnerControls", () => ({
  CommunityBuildOwnerControls: () => null,
}));
vi.mock("@/components/community/RelatedBuilds", () => ({ RelatedBuilds: () => null }));
vi.mock("@/components/community/SaveToLibraryButton", () => ({ SaveToLibraryButton: () => null }));
vi.mock("@/components/community/ShareLinkButton", () => ({ ShareLinkButton: () => null }));

import CommunityBuildPage from "@/app/community/builds/[slug]/page";

const HOSTILE_TITLE = 'Fixture opener</script><script>window.__pwned = 1</script><!--';

function detail(title: string) {
  return {
    slug: "build-fixture0001",
    title,
    description: "Synthetic fixture build.",
    matchup: "PvZ",
    votes: 0,
    publishedAt: "2026-09-01T00:00:00.000Z",
    build: { name: "PvZ - Stargate into Glaives", race: "Protoss" },
  };
}

async function renderPage(title: string) {
  mocks.getJson.mockResolvedValue(detail(title));
  const page = await CommunityBuildPage({ params: Promise.resolve({ slug: "build-fixture0001" }) });
  return render(page);
}

afterEach(() => {
  cleanup();
  mocks.getJson.mockReset();
  mocks.guideLinkProps.length = 0;
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
});
