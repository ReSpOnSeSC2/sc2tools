import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OverlayCheckBadge, OverlaySetupCard } from "../OverlaySetupCard";
import { closestOverlayName } from "../overlayNames";

afterEach(() => { cleanup(); vi.useRealTimers(); window.history.replaceState(null, "", "/"); });
it("suggests only close known names and bounds unusually long input", () => {
  expect(closestOverlayName("opponnent", ["opponent", "scouting"])).toBe("opponent");
  expect(closestOverlayName("completely-unrelated", ["opponent", "scouting"])).toBeNull();
  expect(closestOverlayName("a".repeat(5000), ["opponent"])).toBeNull();
});
it("explains dead links then collapses after a minute without revealing a token", () => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/overlay/secret-value");
  render(<OverlaySetupCard reason="invalid-token" />);
  expect(screen.getByText("This overlay link no longer works")).toBeTruthy();
  expect(document.body.textContent).not.toContain("secret-value");
  act(() => { vi.advanceTimersByTime(60000); });
  expect(screen.getByText("Overlay link invalid")).toBeTruthy();
});
it("shows an opt-in check badge for ten seconds with current live status", () => {
  vi.useFakeTimers(); window.history.replaceState(null, "", "/overlay/private-value?check=1");
  const view = render(<OverlayCheckBadge status="connected" live={false} />);
  expect(screen.getByText("Connected · waiting for a game")).toBeTruthy();
  view.rerender(<OverlayCheckBadge status="connected" live />);
  expect(screen.getByText("Connected · live game")).toBeTruthy();
  act(() => { vi.advanceTimersByTime(10000); });
  expect(screen.queryByRole("status")).toBeNull();
});

it("explains replaced URLs distinctly and keeps the credential out of the card", () => {
  vi.useFakeTimers(); window.history.replaceState(null, "", "/overlay/old-private");
  render(<OverlaySetupCard reason="replaced" />);
  expect(screen.getByText("This overlay URL was replaced — update it in OBS")).toBeTruthy();
  expect(document.body.textContent).not.toContain("old-private");
  act(() => { vi.advanceTimersByTime(60000); });
  expect(screen.getByText("Overlay URL replaced")).toBeTruthy();
});
