import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendOverlayCreditToUrl,
  isOverlayCreditHidden,
  readOverlayCreditPreference,
  setOverlayCreditPreference,
  subscribeOverlayCreditPreference,
} from "@/lib/overlayCredit";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("isOverlayCreditHidden", () => {
  it.each(["0", "off", "false", "no", "hide", " OFF "])("hides the credit for %j", (value) => {
    expect(isOverlayCreditHidden(value)).toBe(true);
  });

  it.each([undefined, null, "", "1", "on", "yes"])("keeps it visible for %j", (value) => {
    expect(isOverlayCreditHidden(value)).toBe(false);
  });

  it("reads the first value of a repeated param", () => {
    expect(isOverlayCreditHidden(["0", "1"])).toBe(true);
  });
});

describe("appendOverlayCreditToUrl", () => {
  it("leaves the URL alone while the credit is shown", () => {
    expect(appendOverlayCreditToUrl("/overlay/tok", true)).toBe("/overlay/tok");
  });

  it("adds credit=0 after any existing query and before a fragment", () => {
    expect(appendOverlayCreditToUrl("/overlay/tok", false)).toBe("/overlay/tok?credit=0");
    expect(appendOverlayCreditToUrl("https://sc2tools.com/overlay/tok?theme=abc", false)).toBe(
      "https://sc2tools.com/overlay/tok?theme=abc&credit=0",
    );
    expect(appendOverlayCreditToUrl("/overlay/tok/widget/ghost-build?voice=1#ghost=xyz", false)).toBe(
      "/overlay/tok/widget/ghost-build?voice=1&credit=0#ghost=xyz",
    );
  });
});

describe("credit preference", () => {
  it("defaults to shown and remembers a hidden choice", () => {
    expect(readOverlayCreditPreference()).toBe(true);
    setOverlayCreditPreference(false);
    expect(readOverlayCreditPreference()).toBe(false);
    setOverlayCreditPreference(true);
    expect(readOverlayCreditPreference()).toBe(true);
  });

  it("notifies subscribers on change", () => {
    const callback = vi.fn();
    const unsubscribe = subscribeOverlayCreditPreference(callback);
    setOverlayCreditPreference(false);
    expect(callback).toHaveBeenCalledTimes(1);
    unsubscribe();
    setOverlayCreditPreference(true);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
