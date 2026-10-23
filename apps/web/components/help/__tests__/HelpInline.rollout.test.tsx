import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelpInline } from "../HelpInline";

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

const TEXT = "Open the [review board](/reviews), [My reviews](/reviews/mine), or [the guide](/help/replay-reviews).";

describe("review links in public help", () => {
  it.each(["off", "admins"])("keeps the guide readable without unavailable feature links during %s rollout", (rollout) => {
    vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", rollout);
    render(<HelpInline text={TEXT} />);
    expect(screen.getByText("review board")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "review board" })).toBeNull();
    expect(screen.queryByRole("link", { name: "My reviews" })).toBeNull();
    expect(screen.getByRole("link", { name: "the guide" }).getAttribute("href")).toBe("/help/replay-reviews");
  });

  it("links to the review pages when the feature is public", () => {
    vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "on");
    render(<HelpInline text={TEXT} />);
    expect(screen.getByRole("link", { name: "review board" }).getAttribute("href")).toBe("/reviews");
    expect(screen.getByRole("link", { name: "My reviews" }).getAttribute("href")).toBe("/reviews/mine");
  });
});
