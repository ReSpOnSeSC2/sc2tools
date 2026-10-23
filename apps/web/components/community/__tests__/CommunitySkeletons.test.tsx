import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  CommunityAuthorSkeleton,
  CommunityBuildSkeleton,
  CommunityListSkeleton,
} from "../CommunitySkeletons";

afterEach(cleanup);

describe("community loading skeletons", () => {
  it("shapes the list like the page: a filter bar and six build cards", () => {
    const { container } = render(<CommunityListSkeleton />);
    expect(screen.getByRole("status").textContent).toBe("Loading community builds…");
    expect(container.querySelectorAll("ul > li")).toHaveLength(6);
  });

  it("shapes a build page: eight build-order rows and three sidebar blocks", () => {
    const { container } = render(<CommunityBuildSkeleton />);
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
    const [timeline, sidebar] = Array.from(container.querySelectorAll(".lg\\:grid-cols-\\[minmax\\(0\\,1fr\\)_320px\\] > div"));
    expect(timeline.children).toHaveLength(8);
    expect(sidebar.children).toHaveLength(3);
  });

  it("shapes an author profile: four stat tiles and six build cards", () => {
    const { container } = render(<CommunityAuthorSkeleton />);
    expect(screen.getByRole("status").textContent).toBe("Loading author profile…");
    expect(container.querySelector(".md\\:grid-cols-4")?.children).toHaveLength(4);
    expect(container.querySelectorAll("ul > li")).toHaveLength(6);
  });

  it("only pulses when motion is allowed", () => {
    const { container } = render(<CommunityBuildSkeleton />);
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(container.querySelector(".motion-safe\\:animate-pulse")).not.toBeNull();
  });
});
