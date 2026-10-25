import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ fail: true, renders: 0 }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "synthetic-owner" }) }));
// The real lazy boundary is under test; normal card/write behavior is covered
// by MacroBuildSelector.test and the full game-page SWR consumer regression.
vi.mock("@/components/build-checkin/BuildCheckInCard", () => ({ BuildCheckInCard: () => {
  h.renders++;
  if (h.fail) throw new Error("Synthetic module render failure");
  return <div>Loaded build selection</div>;
} }));

import { MacroBuildSelector } from "../MacroBuildSelector";

afterEach(() => { cleanup(); vi.restoreAllMocks(); h.fail = true; h.renders = 0; });
describe("Macro build editor recovery", () => {
  it("shows a recoverable error, makes a fresh editor on Retry, and keeps Close usable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<MacroBuildSelector gameId="g1" />);
    expect(h.renders).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Change build" }));
    await screen.findByRole("alert");
    expect(screen.getByText("Build selection couldn't load.")).toBeTruthy();
    expect(screen.queryByText("Synthetic module render failure")).toBeNull();
    h.fail = false;
    const retry = screen.getByRole("button", { name: "Retry build selection" });
    retry.focus();
    fireEvent.click(retry);
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Build selection editor" }));
    await screen.findByText("Loaded build selection");
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Build selection editor" }));
    fireEvent.click(screen.getByRole("button", { name: "Close build selection" }));
    expect(screen.queryByText("Loaded build selection")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Change build" }));
  });

  it("does not take focus back when the user moves elsewhere during Retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<><MacroBuildSelector gameId="g1" /><button>Another control</button></>);
    fireEvent.click(screen.getByRole("button", { name: "Change build" }));
    const retry = await screen.findByRole("button", { name: "Retry build selection" });
    retry.focus(); h.fail = false;
    fireEvent.click(retry);
    const other = screen.getByRole("button", { name: "Another control" });
    other.focus();
    await screen.findByText("Loaded build selection");
    expect(document.activeElement).toBe(other);
  });
});
