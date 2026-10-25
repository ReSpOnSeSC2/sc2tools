import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GameStoryPanel } from "../GameStoryPanel";

const harness = vi.hoisted(() => ({ fail: true }));
vi.mock("../GameStoryCard", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return { GameStoryCard: ({ onAvailabilityChange }: { onAvailabilityChange: (value: boolean) => void }) => {
    react.useEffect(() => onAvailabilityChange(true), [onAvailabilityChange]);
    if (harness.fail) throw new Error("Synthetic chunk failure");
    return <h2>Recovered game story</h2>;
  } };
});
afterEach(() => { cleanup(); harness.fail = true; vi.restoreAllMocks(); });

it("keeps existing analysis mounted and retries a failed story chunk independently", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(<GameStoryPanel input={{ gameId: "failure", result: "Victory" }} mechanics={<p data-testid="mechanics-before-error">Mechanics stays</p>} onSeek={vi.fn()} />);
  const mechanics = screen.getByTestId("mechanics-before-error");
  const retry = await screen.findByRole("button", { name: "Try game story again" });
  expect(screen.getByTestId("mechanics-before-error")).toBe(mechanics);
  harness.fail = false;
  fireEvent.click(retry);
  expect(await screen.findByRole("heading", { name: "Recovered game story" })).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByTestId("mechanics-before-error")).toBe(mechanics);
});
