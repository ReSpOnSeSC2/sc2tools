import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ pathname: "/app/maps", filters: { preset: "season:67", race: "P", opp_race: "Z", regions: "EU" } }));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("@/lib/filterContext", () => ({ useFilters: () => ({ filters: state.filters }) }));
import { CopyViewLink } from "../CopyViewLink";
const writeText = vi.fn();
beforeEach(() => { state.pathname = "/app/maps"; writeText.mockReset().mockResolvedValue(undefined); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } }); });
afterEach(cleanup);
it("copies a complete cohort and section without exposing local tokens or unrelated query state", async () => {
  window.history.replaceState(null, "", "/app/maps?token=private&q=local");
  render(<CopyViewLink />); fireEvent.click(screen.getByRole("button", { name: "Copy link to this view" }));
  await screen.findByRole("status");
  const url = new URL(writeText.mock.calls[0][0]);
  expect(url.pathname).toBe("/app/maps"); expect(url.searchParams.get("filters")).toBe("1");
  expect(url.searchParams.get("preset")).toBe("season:67"); expect(url.searchParams.get("regions")).toBe("EU");
  expect(url.searchParams.has("token")).toBe(false); expect(url.searchParams.has("q")).toBe(false);
});
it("offers a selected read-only fallback when clipboard access fails", async () => {
  writeText.mockRejectedValue(new Error("denied")); render(<CopyViewLink />);
  fireEvent.click(screen.getByRole("button", { name: "Copy link to this view" }));
  const field = await screen.findByLabelText("Copy this view link") as HTMLInputElement;
  await waitFor(() => expect(document.activeElement).toBe(field));
  expect(field.readOnly).toBe(true); expect(field.selectionEnd).toBe(field.value.length);
});
it("does not offer a misleading filter link on an individual game", () => {
  state.pathname = "/app/game/g1"; render(<CopyViewLink />); expect(screen.queryByRole("button")).toBeNull();
});
it("does not restore an old link fallback after the user switches views during a clipboard request", async () => {
  let reject!: (error: Error) => void;
  writeText.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  const view = render(<CopyViewLink />);
  fireEvent.click(screen.getByRole("button", { name: "Copy link to this view" }));
  state.pathname = "/app/trends";
  view.rerender(<CopyViewLink />);
  await act(async () => reject(new Error("denied")));
  expect(screen.queryByLabelText("Copy this view link")).toBeNull(); expect(screen.queryByRole("status")).toBeNull();
});
