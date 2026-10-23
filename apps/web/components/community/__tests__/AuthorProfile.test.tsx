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

  test("escapes hostile author names inside JSON-LD without changing their data", () => {
    const displayName = '</script><script>alert(1)</script>';
    const { container } = render(<AuthorProfile profile={{ ...profile, displayName }} />);
    const body = container.querySelector('script[type="application/ld+json"]')!.textContent!;
    expect(body).not.toContain("</script");
    expect(body).not.toContain("<");
    expect(JSON.parse(body).name).toBe(displayName);
  });
});
