import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AuthorProfile } from "../AuthorProfile";
import type { CommunityAuthorProfile } from "../types";

/**
 * Community author pages share the public-profile opt-in (a published
 * build under a public author name), so each one links to the author's
 * /p/ player profile — previously nothing linked there.
 */

const profile: CommunityAuthorProfile = {
  userId: "user 42",
  displayName: "ReSpOnSe",
  joinedAt: null,
  builds: [],
  totalBuilds: 0,
  totalVotes: 0,
  primaryRace: null,
  topMatchup: null,
  topBuild: null,
  recent: [],
};

describe("AuthorProfile", () => {
  afterEach(cleanup);

  test("links to the author's public player profile", () => {
    render(<AuthorProfile profile={profile} />);
    const link = screen.getByRole("link", { name: /player profile/i });
    expect(link.getAttribute("href")).toBe("/p/user%2042");
  });
});
