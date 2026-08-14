import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../AuthorChip", () => ({ AuthorChip: () => <span>Author</span> }));
vi.mock("../CommunityBuildOwnerControls", () => ({
  CommunityBuildOwnerControls: () => null,
}));
vi.mock("../CommunityOwnerReplayCount", () => ({
  CommunityOwnerReplayCount: () => <span>41 classified replays</span>,
}));

import { CommunityBuildCard } from "../CommunityBuildCard";

afterEach(cleanup);

describe("CommunityBuildCard vote score", () => {
  it("visibly identifies the score as votes rather than replay matches", () => {
    render(
      <CommunityBuildCard
        build={{
          slug: "pvt-three-gate",
          ownerUserId: "owner-1",
          title: "PvT 3 Gate",
          description: "Three gate pressure",
          matchup: "PvT",
          votes: 0,
          publishedAt: "2026-08-13T12:00:00.000Z",
          build: { race: "Protoss" },
        }}
      />,
    );

    expect(screen.getByText(/0 votes/)).toBeTruthy();
    expect(screen.getByLabelText("0 net votes")).toBeTruthy();
    expect(screen.getByText("41 classified replays")).toBeTruthy();
  });
});
