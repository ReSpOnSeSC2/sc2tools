import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PublicUnavailable } from "../PublicUnavailable";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), path: "/players/busy/replays" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }), usePathname: () => mocks.path, useSearchParams: () => new URLSearchParams("search=macro") }));
beforeEach(() => { vi.useFakeTimers(); mocks.refresh.mockReset(); mocks.path = "/players/busy/replays"; window.sessionStorage.clear(); vi.spyOn(document, "hidden", "get").mockReturnValue(false); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("offers manual recovery and pauses a polite countdown while hidden", () => {
  const hidden = vi.spyOn(document, "hidden", "get"); hidden.mockReturnValue(true);
  render(<PublicUnavailable surface="archive" reason="busy" />);
  expect(screen.getByRole("heading", { name: "Lots of visitors right now" })).toBeTruthy();
  act(() => vi.advanceTimersByTime(5000)); expect(screen.getByRole("status").textContent).toBe("Retrying in 10…");
  hidden.mockReturnValue(false); act(() => vi.advanceTimersByTime(10000)); expect(mocks.refresh).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Try again" })); expect(mocks.refresh).toHaveBeenCalledTimes(2);
});
it("automatically retries at most three times per URL, including after remount", () => {
  const ui = render(<PublicUnavailable surface="archive" reason="busy" />);
  for (let i = 0; i < 4; i++) act(() => vi.advanceTimersByTime(10000));
  expect(mocks.refresh).toHaveBeenCalledTimes(3); expect(screen.queryByRole("status")).toBeNull();
  ui.unmount(); render(<PublicUnavailable surface="archive" reason="busy" />); act(() => vi.advanceTimersByTime(30000)); expect(mocks.refresh).toHaveBeenCalledTimes(3);
});
it("retries only once when session storage is blocked", () => {
  mocks.path = "/players/storage-blocked/replays"; vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); }); vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  render(<PublicUnavailable surface="analysis" reason="busy" />);
  act(() => vi.advanceTimersByTime(10000)); act(() => vi.advanceTimersByTime(10000)); expect(mocks.refresh).toHaveBeenCalledTimes(1);
});
it("still honors the memory budget when reading storage fails but writing succeeds", () => {
  mocks.path = "/players/storage-read-blocked/replays"; vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  render(<PublicUnavailable surface="archive" reason="busy" />);
  act(() => vi.advanceTimersByTime(10000)); act(() => vi.advanceTimersByTime(10000)); expect(mocks.refresh).toHaveBeenCalledTimes(1);
});
it("uses the outage title and provides a way out of filtered archives", () => {
  render(<PublicUnavailable surface="archive" reason="outage" resetHref="/players/coach/replays" />);
  expect(screen.getByRole("heading", { name: "Replay archive temporarily unavailable" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Back to first page" }).getAttribute("href")).toBe("/players/coach/replays");
  expect(screen.queryByRole("status")).toBeNull();
});
