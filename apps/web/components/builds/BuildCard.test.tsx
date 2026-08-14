import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BuildCard } from "./BuildCard";
import type { DecoratedBuild } from "./types";

const callbacks = {
  onOpen: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onPublish: vi.fn(),
};

function build(overrides: Partial<DecoratedBuild> = {}): DecoratedBuild {
  return {
    slug: "pvt-three-gate",
    name: "PvT 3 Gate",
    race: "Protoss",
    vsRace: "Terran",
    ...overrides,
  };
}

afterEach(cleanup);

describe("BuildCard replay-stat states", () => {
  it("does not describe an unfinished request as zero matches", () => {
    render(<BuildCard build={build({ statsState: "loading" })} {...callbacks} />);

    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("No classified replays")).toBeNull();
  });

  it("does not describe an API failure as zero matches", () => {
    render(
      <BuildCard build={build({ statsState: "unavailable" })} {...callbacks} />,
    );

    expect(screen.getByText("Temporarily unavailable")).toBeTruthy();
    expect(screen.queryByText("No classified replays")).toBeNull();
  });

  it("shows zero only after a successful stats response", () => {
    render(<BuildCard build={build({ statsState: "ready" })} {...callbacks} />);

    expect(screen.getByText("No classified replays")).toBeTruthy();
  });
});
