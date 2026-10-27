import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearDraft, loadDraft, pruneDrafts, saveDraft } from "./reviewDrafts";

const key = (request = "request", parent = "root") => `sc2tools:review-draft:v2:viewer:${request}:${parent === "root" ? "root" : `reply:${parent}`}`;
const draft = { body: "Scout the natural before moving out.", start: 312, end: 340 };
beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-23T12:00:00Z")); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("isolates account keys, never restores unattributed legacy drafts, and cannot persist signed-out drafts", () => {
  localStorage.setItem("sc2tools:review-draft:v1:request:root", JSON.stringify({ ...draft, body: "Unknown owner's old draft.", savedAt: Date.now() }));
  expect(loadDraft("viewer", "request")).toBeNull();
  saveDraft("viewer", "request", null, draft);
  saveDraft("other-viewer", "request", null, { ...draft, body: "Another account's draft." });
  expect(loadDraft("viewer", "request")?.body).toBe(draft.body);
  expect(loadDraft("other-viewer", "request")?.body).toBe("Another account's draft.");
  clearDraft("viewer", "request"); expect(loadDraft("other-viewer", "request")).not.toBeNull();
  saveDraft(null, "signed-out", null, draft); expect(loadDraft(null, "signed-out")).toBeNull();
  expect(localStorage.getItem("sc2tools:review-draft:v1:request:root")).not.toBeNull();
});

it("keeps independent drafts per request and root/reply and clears only the selected one", () => {
  saveDraft("viewer", "request", null, draft); saveDraft("viewer", "request", "reply", { ...draft, body: "A reply draft." });
  saveDraft("viewer", "other", null, { ...draft, body: "Another request." });
  expect(loadDraft("viewer", "request")).toEqual({ ...draft, savedAt: Date.now() });
  expect(loadDraft("viewer", "request", "reply")?.body).toBe("A reply draft.");
  clearDraft("viewer", "request"); expect(loadDraft("viewer", "request")).toBeNull();
  expect(loadDraft("viewer", "other")?.body).toBe("Another request.");
});

it("expires drafts after fourteen days and removes malformed entries without touching other storage", () => {
  localStorage.setItem(key(), JSON.stringify({ ...draft, savedAt: Date.now() - 14 * 86400_000 - 1 }));
  localStorage.setItem(key("malformed"), '{"body":42}'); localStorage.setItem(key("broken-json"), "{"); localStorage.setItem("other-pref", "keep");
  expect(loadDraft("viewer", "request")).toBeNull();
  expect(localStorage.getItem(key())).toBeNull(); expect(localStorage.getItem(key("malformed"))).toBeNull();
  expect(localStorage.getItem(key("broken-json"))).toBeNull();
  expect(localStorage.getItem("other-pref")).toBe("keep");
});

it("keeps the twenty most recent drafts and an empty save removes its old draft", () => {
  for (let index = 0; index < 23; index += 1) { vi.advanceTimersByTime(1); saveDraft("viewer", String(index), null, draft); }
  expect(localStorage.length).toBe(20); expect(loadDraft("viewer", "2")).toBeNull(); expect(loadDraft("viewer", "3")).not.toBeNull();
  expect(loadDraft("viewer", "22")).not.toBeNull(); saveDraft("viewer", "22", null, { ...draft, body: "  " });
  expect(localStorage.getItem(key("22"))).toBeNull();
});

it("never throws when storage is unavailable or full, and does not delete drafts when reads fail", () => {
  saveDraft("viewer", "request", null, draft);
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(loadDraft("viewer", "request")).toBeNull(); expect(pruneDrafts).not.toThrow(); read.mockRestore();
  expect(localStorage.getItem(key())).not.toBeNull();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  expect(() => saveDraft("viewer", "another", null, draft)).not.toThrow();
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(() => clearDraft("viewer", "request")).not.toThrow();
});
