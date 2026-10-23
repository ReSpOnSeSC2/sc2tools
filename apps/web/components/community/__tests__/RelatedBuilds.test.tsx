import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getJsonWithStatus: vi.fn() }));

vi.mock("@/lib/serverApi", () => ({ getJsonWithStatus: mocks.getJsonWithStatus }));
vi.mock("@/components/ui/Icon", () => ({ Icon: () => null }));

import { RelatedBuilds } from "../RelatedBuilds";

afterEach(() => {
  cleanup();
  mocks.getJsonWithStatus.mockReset();
});

describe("RelatedBuilds", () => {
  it("renders nothing when the list can't be fetched", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: null, status: null });
    const { container } = render(<>{await RelatedBuilds({ matchup: "PvZ", currentSlug: "build-a" })}</>);
    expect(container.innerHTML).toBe("");
  });

  it("lists other builds in the matchup, without the current one", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({
      data: {
        items: [
          { slug: "build-a", title: "Current build", matchup: "PvZ", votes: 3, build: { race: "Protoss" } },
          { slug: "build-b", title: "Another opener", matchup: "PvZ", votes: 2, build: { race: "Protoss" } },
        ],
      },
      status: 200,
    });
    render(<>{await RelatedBuilds({ matchup: "PvZ", currentSlug: "build-a" })}</>);
    expect(screen.getByRole("heading", { name: "More PvZ builds" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Another opener/ }).getAttribute("href")).toBe("/community/builds/build-b");
    expect(screen.queryByText("Current build")).toBeNull();
  });
});
