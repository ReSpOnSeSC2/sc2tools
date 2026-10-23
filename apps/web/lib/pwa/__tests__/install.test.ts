import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { detectInstallPlatform, isStandalone, startInstallCapture, useInstallState, type BeforeInstallPromptEvent } from "../install";
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each([
  ["iPhone Version/17 Mobile Safari/604", "ios-safari"], ["iPhone CriOS/120 Mobile Safari/604", "ios-other"],
  ["iPad FxiOS/120 Mobile Safari/604", "ios-other"], ["Android Chrome/120", "android"],
  ["Windows Chrome/120", "desktop-chromium"], ["Windows Edg/120", "desktop-chromium"],
  ["Macintosh Version/17 Safari/604", "unsupported"], ["Windows Firefox/120", "unsupported"],
])("detects %s", (ua, expected) => { vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua); expect(detectInstallPlatform()).toBe(expected); });
it("detects touch iPadOS despite its Macintosh user agent", () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh Version/17 Safari/604");
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
  expect(detectInstallPlatform()).toBe("ios-safari");
  if (descriptor) Object.defineProperty(navigator, "maxTouchPoints", descriptor); else delete (navigator as { maxTouchPoints?: number }).maxTouchPoints;
});
it("captures the one-shot native event before a subscriber mounts and shares it", async () => {
  startInstallCapture(); const event = new Event("beforeinstallprompt", { cancelable: true }) as BeforeInstallPromptEvent;
  const prompt = vi.fn(async () => {}); Object.assign(event, { prompt, userChoice: Promise.resolve({ outcome: "accepted", platform: "web" }) });
  window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
  const { result } = renderHook(useInstallState); expect(result.current.available).toBe(true);
  let first!: Promise<string>; let second!: Promise<string>;
  act(() => { first = result.current.promptInstall(); second = result.current.promptInstall(); });
  await act(async () => { expect(await first).toBe("accepted"); expect(await second).toBe("unavailable"); });
  expect(prompt).toHaveBeenCalledOnce(); expect(result.current.installed).toBe(true); expect(result.current.available).toBe(false);
});
it("appinstalled removes availability for every subscriber", () => {
  startInstallCapture(); const event = new Event("beforeinstallprompt", { cancelable: true }); Object.assign(event, { prompt: vi.fn(), userChoice: Promise.resolve({ outcome: "dismissed" }) });
  window.dispatchEvent(event); const one = renderHook(useInstallState); const two = renderHook(useInstallState);
  act(() => window.dispatchEvent(new Event("appinstalled")));
  expect(one.result.current.installed).toBe(true); expect(two.result.current.installed).toBe(true); expect(one.result.current.available).toBe(false);
});
it("recognizes an already installed display mode", () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  expect(isStandalone()).toBe(true);
});
