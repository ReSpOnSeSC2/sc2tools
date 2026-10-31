import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceNote, mayHaveDeviceCopy, noteDeviceCopy } from "../deviceNote";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function refuse(method: "getItem" | "setItem", name: string) {
  vi.spyOn(Storage.prototype, method).mockImplementation(() => {
    throw new DOMException("refused", name);
  });
}

describe("the device note", () => {
  it("names one account at a time", () => {
    expect([deviceNote(), mayHaveDeviceCopy("user-a")]).toEqual([null, false]);
    expect(noteDeviceCopy("user-a")).toBe(true);
    expect([deviceNote(), mayHaveDeviceCopy("user-a"), mayHaveDeviceCopy("user-b")]).toEqual(["user-a", true, false]);
    expect(noteDeviceCopy("user-b")).toBe(true);
    expect([mayHaveDeviceCopy("user-a"), mayHaveDeviceCopy("user-b")]).toEqual([false, true]);
  });

  it("fails closed on a refused write, unless the note already names that account", () => {
    noteDeviceCopy("user-a");
    refuse("setItem", "QuotaExceededError");
    expect([noteDeviceCopy("user-a"), noteDeviceCopy("user-b"), deviceNote()]).toEqual([true, false, "user-a"]);
  });

  it("fails closed when the note cannot be read, while only a probe can tell what is kept", () => {
    refuse("getItem", "SecurityError");
    expect([deviceNote(), mayHaveDeviceCopy("user-a"), noteDeviceCopy("user-a")]).toEqual([undefined, true, false]);
  });
});
