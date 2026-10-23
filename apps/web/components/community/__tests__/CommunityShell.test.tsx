import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CommunityShell } from "../CommunityShell";
afterEach(cleanup);
it("exposes ordinary section links and the active page", () => {
  render(<CommunityShell active="builds" buildCount={57}><div>builds-body</div></CommunityShell>);
  const builds=screen.getByRole("link",{name:"Builds · 57"});
  expect(builds.getAttribute("href")).toBe("/community"); expect(builds.getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link",{name:"Stock Market leaderboard"}).getAttribute("href")).toBe("/community/leaderboard");
  expect(screen.queryByRole("tab")).toBeNull(); expect(screen.getByText("builds-body")).toBeTruthy();
});
it("marks the leaderboard route current", () => {
  render(<CommunityShell active="leaderboard"><div>board</div></CommunityShell>);
  expect(screen.getByRole("link",{name:"Stock Market leaderboard"}).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link",{name:"Builds"}).hasAttribute("aria-current")).toBe(false);
});
