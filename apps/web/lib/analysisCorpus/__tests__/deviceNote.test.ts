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
  it("names one account and forgets it with null", () => {
    expect([deviceNote(), mayHaveDeviceCopy("user-a")]).toEqual([null, false]);
    expect(noteDeviceCopy("user-a")).toBe(true);
    expect([deviceNote(), mayHaveDeviceCopy("user-a"), mayHaveDeviceCopy("user-b")]).toEqual(["user-a", true, false]);
    expect(noteDeviceCopy(null)).toBe(true);
    expect([deviceNote(), mayHaveDeviceCopy("user-a")]).toEqual([null, false]);
  });

  it("fails closed on a refused write, unless the note already reads as asked", () => {
    noteDeviceCopy("user-a");
    refuse("setItem", "QuotaExceededError");
    expect([noteDeviceCopy("user-a"), noteDeviceCopy("user-b"), deviceNote()]).toEqual([true, false, "user-a"]);
  });

  it("fails closed when the note cannot be read, while only a probe can tell what is kept", () => {
    refuse("getItem", "SecurityError");
    expect([deviceNote(), mayHaveDeviceCopy("user-a"), noteDeviceCopy("user-a"), noteDeviceCopy(null)])
      .toEqual([undefined, true, false, false]);
  });
});
