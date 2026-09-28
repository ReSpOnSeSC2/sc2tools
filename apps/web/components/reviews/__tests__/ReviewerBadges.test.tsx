import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewerBadges } from "../ReviewerBadges";
import type { ReviewCommentAuthor } from "@/lib/reviews";

afterEach(cleanup);

function author(verified: ReviewCommentAuthor["verified"]): ReviewCommentAuthor {
  return { label: "ReSpOnSe", isAsker: false, profileHref: null, verified, badges: [], flair: null };
}

describe("ReviewerBadges", () => {
  it("shows the verified league in each region the reviewer plays in", () => {
    const gm = { id: 6, label: "Grandmaster" };
    render(<ReviewerBadges author={author({
      band: gm,
      race: "Protoss",
      mmr: 5400,
      regions: [
        { region: "NA", band: gm, race: "Protoss" },
        { region: "EU", band: gm, race: "Protoss" },
      ],
    })} />);
    expect(screen.getByText("Grandmaster Protoss (NA, EU)")).toBeTruthy();
  });

  it("says Unverified without a verified league", () => {
    render(<ReviewerBadges author={author(null)} />);
    expect(screen.getByText("Unverified")).toBeTruthy();
  });
});
