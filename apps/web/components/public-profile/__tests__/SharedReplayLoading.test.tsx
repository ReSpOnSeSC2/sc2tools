import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import SharedReplayAnalysisLoading from "@/app/players/[player]/replays/[gameId]/loading";

afterEach(cleanup);

it("the canonical shared analysis route announces loading without fake replay data or actions", () => {
  const { container } = render(<SharedReplayAnalysisLoading />);
  const status = screen.getByRole("status");
  expect(status.getAttribute("aria-busy")).toBe("true");
  expect(status.textContent).toBe("Loading shared replay analysis");
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.queryByRole("link")).toBeNull(); expect(screen.queryByRole("button")).toBeNull();
  expect(container.textContent).not.toMatch(/Win|Loss|0%|Unknown opponent/);
});
