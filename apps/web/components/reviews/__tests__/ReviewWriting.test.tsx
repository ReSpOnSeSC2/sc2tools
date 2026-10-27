import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReviewComment } from "@/lib/reviews";
import { saveDraft } from "@/lib/reviewDrafts";

const h = vi.hoisted(() => ({ apiCall: vi.fn(), posted: vi.fn(), cancel: vi.fn(), clearPin: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "viewer", getToken: async () => "token" }) }));
vi.mock("@/lib/clientApi", async (original) => ({ ...await original<typeof import("@/lib/clientApi")>(), apiCall: h.apiCall }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: vi.fn() }));

import { ReviewComposer } from "../ReviewComposer";
import { CommentEditor } from "../CommentEditor";
import { digitsToClock, parseClock } from "@/lib/reviews";

const key = "sc2tools:review-draft:v2:viewer:request:root";
const props = { requestId: "request", durationSec: 640, currentTime: 330, initialTime: 312, draftPin: null, pinMode: false,
  onTogglePinMode: () => {}, onClearPin: h.clearPin, onPosted: h.posted, onCancel: h.cancel, canPin: false };
const comment = { id: "comment", body: "Scout before moving out.", gameTimeSec: 120, endTimeSec: null, createdAt: null } as ReviewComment;
beforeEach(() => { localStorage.clear(); h.apiCall.mockReset(); h.apiCall.mockResolvedValue({ id: "new" }); h.posted.mockReset(); h.cancel.mockReset(); h.clearPin.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("debounces a ranged draft, restores it after remount and clears it after posting", async () => {
  vi.useFakeTimers();
  const first = render(<ReviewComposer {...props} />);
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Hold the blink until reinforcements arrive." } });
  fireEvent.click(screen.getByRole("button", { name: "End range here" }));
  await act(async () => vi.advanceTimersByTime(499)); expect(localStorage.getItem(key)).toBeNull();
  await act(async () => vi.advanceTimersByTime(1));
  expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ body: "Hold the blink until reinforcements arrive.", start: 312, end: 330 });
  first.unmount(); render(<ReviewComposer {...props} />);
  expect(screen.getByRole("status").textContent).toContain("Draft restored (at 5:12)");
  expect(screen.getByTestId("composer-time").textContent).toBe("5:12–5:30");
  await act(async () => fireEvent.keyDown(screen.getByLabelText("Comment"), { key: "Enter", ctrlKey: true }));
  expect(h.posted).toHaveBeenCalledWith("new"); expect(localStorage.getItem(key)).toBeNull();
});

it("restores the text but resets a saved range that no longer fits the game", () => {
  saveDraft("viewer", "request", null, { body: "A useful draft from a longer replay.", start: 700, end: 730 });
  render(<ReviewComposer {...props} />);
  expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toContain("longer replay");
  expect(screen.getByTestId("composer-time").textContent).toBe("at 5:12");
  fireEvent.click(within(screen.getByRole("status")).getByRole("button", { name: "Use current time" }));
  expect(screen.getByTestId("composer-time").textContent).toBe("at 5:30");
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("");
  expect(localStorage.getItem(key)).toBeNull(); expect(h.clearPin).toHaveBeenCalledOnce();
});

it("confirms cancellation with text, keeps editing, and removes the draft only on discard", () => {
  saveDraft("viewer", "request", null, { body: "This advice should survive cancellation.", start: 312, end: null });
  render(<ReviewComposer {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(h.cancel).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog", { name: "Discard this comment?" });
  expect(dialog.textContent).toContain("Your text will be removed from this browser.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
  expect(localStorage.getItem(key)).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Discard" }));
  expect(h.cancel).toHaveBeenCalledOnce(); expect(localStorage.getItem(key)).toBeNull();
});

it("cancels an empty comment immediately and posts even when storage throws", async () => {
  const { unmount } = render(<ReviewComposer {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(h.cancel).toHaveBeenCalledOnce(); unmount();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
  render(<ReviewComposer {...props} />);
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Scout the third base before moving out." } });
  fireEvent.keyDown(screen.getByLabelText("Comment"), { key: "Enter", metaKey: true });
  await waitFor(() => expect(h.posted).toHaveBeenCalledWith("new"));
});

it("ignores keyboard submit during IME composition and while a post is in flight", async () => {
  let finish!: (result: { id: string }) => void;
  h.apiCall.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  render(<ReviewComposer {...props} />);
  const input = screen.getByLabelText("Comment"); fireEvent.change(input, { target: { value: "Scout the third base before moving out." } });
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, isComposing: true }); expect(h.apiCall).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true }); fireEvent.keyDown(input, { key: "Enter", metaKey: true });
  expect(h.apiCall).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Comment at 5:12" }).getAttribute("aria-keyshortcuts")).toBe("Control+Enter Meta+Enter");
  await act(async () => finish({ id: "new" }));
});

it("explains the Mac shortcut after mount", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel"); render(<ReviewComposer {...props} />);
  expect(screen.getByText("At least 10 characters · ⌘+Enter to post")).toBeTruthy();
});

it("validates edits with associated feedback and saves with a keyboard shortcut and loading state", async () => {
  let finish!: (value: boolean) => void;
  const save = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const cancel = vi.fn(); render(<CommentEditor comment={comment} durationSec={640} onSave={save} onCancel={cancel} />);
  const input = screen.getByRole("textbox", { name: "Edit comment" });
  fireEvent.change(input, { target: { value: "short" } }); fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  expect(save).not.toHaveBeenCalled(); expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByRole("alert").textContent).toContain("at least 10");
  expect(input.getAttribute("aria-describedby")?.split(" ").some((id) => document.getElementById(id)?.contains(screen.getByRole("alert")))).toBe(true);
  fireEvent.change(input, { target: { value: "Scout the natural before moving out." } });
  fireEvent.keyDown(input, { key: "Enter", metaKey: true });
  expect(save).toHaveBeenCalledWith("Scout the natural before moving out.");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true }); expect(save).toHaveBeenCalledOnce();
  await act(async () => finish(true)); expect(cancel).toHaveBeenCalledOnce();
});

it("counts down the edit window, then disables Save while keeping text available", async () => {
  vi.useFakeTimers(); const now = Date.parse("2026-10-23T12:00:00Z"); vi.setSystemTime(now);
  render(<CommentEditor comment={{ ...comment, createdAt: new Date(now - 3 * 60_000).toISOString() }} durationSec={640} onSave={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByText("Editable for 12 more min")).toBeTruthy();
  await act(async () => vi.advanceTimersByTime(12 * 60_000));
  expect(screen.getByText("The 15-minute edit window has closed. Copy your text before cancelling.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(comment.body);
});

it("guards changed edit text and shows API errors inline without losing it", async () => {
  const cancel = vi.fn(); const save = vi.fn().mockRejectedValue({ message: "The edit window expired on the server." });
  render(<CommentEditor comment={comment} durationSec={640} onSave={save} onCancel={cancel} />);
  expect(screen.queryByText(/Editable for/)).toBeNull();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Scout their third before moving out." } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toBe("The edit window expired on the server.");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(cancel).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog", { name: "Discard this comment?" })).getByRole("button", { name: "Discard" }));
  expect(cancel).toHaveBeenCalledOnce();
});

it("offers a clock suggestion while preserving numeric seconds parsing", () => {
  expect(digitsToClock("500")).toBe("5:00"); expect(digitsToClock("1230")).toBe("12:30");
  expect(digitsToClock("159")).toBe("1:59"); expect(digitsToClock("160")).toBeNull();
  expect(digitsToClock("5:00")).toBeNull(); expect(parseClock("500")).toBe(500);
});
