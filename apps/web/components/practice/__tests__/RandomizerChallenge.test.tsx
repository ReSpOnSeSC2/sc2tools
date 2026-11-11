import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RandomizerChallenge } from "../RandomizerChallenge";

const sample = { challengeStartedAt: null, pools: [
  { matchup: "PvZ", enabled: true, builds: 3, completed: 2,
    rolled: 7, playedAsRolled: 4, wins: 3, losses: 1, lastPlayed: "2026-11-07T14:10:00Z" },
] };
const fixture = vi.hoisted(() => ({ userId: "owner" as string | null, request: vi.fn(), mutate: vi.fn(), useApi: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: fixture.userId }) }));
vi.mock("@/lib/clientApi", () => ({ useApi: fixture.useApi }));
vi.mock("@/lib/useUserSocket", () => ({ useUserSocket: () => undefined }));
beforeEach(() => {
  fixture.userId = "owner";
  fixture.useApi.mockReturnValue({ data: sample, request: fixture.request, mutate: fixture.mutate });
  fixture.request.mockResolvedValue({ challengeStartedAt: "2026-11-11T18:00:00Z" });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("displays private per-pool progress, record and last-played data", () => {
  render(<RandomizerChallenge />);
  expect(fixture.useApi).toHaveBeenCalledWith("/v1/build-intents/randomizer-stats");
  const table = within(screen.getByRole("table", { name: "Randomizer challenge results" }));
  expect(table.getByRole("columnheader", { name: "Played as rolled" })).toBeTruthy();
  expect(table.getByRole("rowheader", { name: "PvZ" })).toBeTruthy();
  expect(table.getAllByRole("cell").slice(0, 4).map((cell) => cell.textContent)).toEqual(["7", "4", "3–1", "2 / 3"]);
  expect(table.getAllByRole("cell")[4].textContent).toMatch(/2026/);
});

it("requires a reset confirmation, preserves the pool, and clears old challenge totals", async () => {
  render(<RandomizerChallenge />);
  const open = screen.getByRole("button", { name: "Reset challenge" });
  fireEvent.click(open);
  const dialog = screen.getByRole("dialog", { name: "Reset this challenge?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(fixture.request).not.toHaveBeenCalled();
  fireEvent.click(open);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reset challenge" }));
  await waitFor(() => expect(fixture.mutate).toHaveBeenCalledTimes(1));
  expect(fixture.request).toHaveBeenCalledWith({ method: "POST" });
  const [patch, options] = fixture.mutate.mock.calls[0];
  expect(options).toEqual({ revalidate: true });
  expect(patch(sample)).toEqual({
    challengeStartedAt: "2026-11-11T18:00:00Z",
    pools: [{ matchup: "PvZ", enabled: true, builds: 3, completed: 0, rolled: 0, playedAsRolled: 0, wins: 0, losses: 0, lastPlayed: null }],
  });
  expect(screen.getByRole("status").textContent).toBe("Challenge reset.");
});

it("omits challenge requests for a signed-out viewer", () => {
  fixture.userId = null;
  render(<RandomizerChallenge />);
  expect(fixture.useApi).not.toHaveBeenCalled();
  expect(screen.queryByRole("heading", { name: "Randomizer challenge" })).toBeNull();
});
