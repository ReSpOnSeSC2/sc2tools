import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearDraft, loadDraft, pruneDrafts, saveDraft } from "./reviewDrafts";

const key = (request = "request", parent = "root") => `sc2tools:review-draft:v1:${request}:${parent}`;
const draft = { body: "Scout the natural before moving out.", start: 312, end: 340 };
beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-23T12:00:00Z")); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("keeps independent drafts per request and root/reply and clears only the selected one", () => {
  saveDraft("request", null, draft); saveDraft("request", "reply", { ...draft, body: "A reply draft." });
  saveDraft("other", null, { ...draft, body: "Another request." });
  expect(loadDraft("request")).toEqual({ ...draft, savedAt: Date.now() });
  expect(loadDraft("request", "reply")?.body).toBe("A reply draft.");
  clearDraft("request"); expect(loadDraft("request")).toBeNull();
  expect(loadDraft("other")?.body).toBe("Another request.");
});

it("expires drafts after fourteen days and removes malformed entries without touching other storage", () => {
  localStorage.setItem(key(), JSON.stringify({ ...draft, savedAt: Date.now() - 14 * 86400_000 - 1 }));
  localStorage.setItem(key("malformed"), '{"body":42}'); localStorage.setItem(key("broken-json"), "{"); localStorage.setItem("other-pref", "keep");
  expect(loadDraft("request")).toBeNull();
  expect(localStorage.getItem(key())).toBeNull(); expect(localStorage.getItem(key("malformed"))).toBeNull();
  expect(localStorage.getItem(key("broken-json"))).toBeNull();
  expect(localStorage.getItem("other-pref")).toBe("keep");
});

it("keeps the twenty most recent drafts and an empty save removes its old draft", () => {
  for (let index = 0; index < 23; index += 1) { vi.advanceTimersByTime(1); saveDraft(String(index), null, draft); }
  expect(localStorage.length).toBe(20); expect(loadDraft("2")).toBeNull(); expect(loadDraft("3")).not.toBeNull();
  expect(loadDraft("22")).not.toBeNull(); saveDraft("22", null, { ...draft, body: "  " });
  expect(localStorage.getItem(key("22"))).toBeNull();
});

it("never throws when storage is unavailable or full, and does not delete drafts when reads fail", () => {
  saveDraft("request", null, draft);
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(loadDraft("request")).toBeNull(); expect(pruneDrafts).not.toThrow(); read.mockRestore();
  expect(localStorage.getItem(key())).not.toBeNull();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  expect(() => saveDraft("another", null, draft)).not.toThrow();
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(() => clearDraft("request")).not.toThrow();
});
