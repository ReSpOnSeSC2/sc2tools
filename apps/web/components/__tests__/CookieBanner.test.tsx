import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CookieBanner } from "../CookieBanner";
import { openCookieSettings, readConsent, setConsent } from "@/lib/analytics/consent";
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });
it("accepts the choice for this session when storage is blocked", () => {
  localStorage.clear(); render(<CookieBanner />);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  expect(readConsent()).toBe("granted"); expect(screen.queryByRole("dialog")).toBeNull();
});
it("reopens with the real choice and restores focus after Escape", () => {
  setConsent("denied"); render(<><button type="button" onClick={openCookieSettings}>Change cookies</button><CookieBanner /></>);
  const trigger = screen.getByRole("button", { name: "Change cookies" }); trigger.focus(); fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "Cookie settings" })).toBe(document.activeElement);
  expect(screen.getByText("Analytics is currently off")).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" }); expect(document.activeElement).toBe(trigger); expect(screen.queryByRole("dialog")).toBeNull();
});
it("turns off a running tracker from the reopened controls", () => {
  setConsent("granted"); render(<CookieBanner />); act(() => openCookieSettings());
  fireEvent.click(screen.getByRole("button", { name: "Turn off analytics" })); expect(readConsent()).toBe("denied");
});
