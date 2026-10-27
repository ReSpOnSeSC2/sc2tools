import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ auth: { isLoaded: true, isSignedIn: true, userId: "A" as string | null, getToken: vi.fn<() => Promise<string | null>>() } }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => h.auth }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: vi.fn() }));
import { ReviewComposer } from "../ReviewComposer";
import { loadDraft, saveDraft } from "@/lib/reviewDrafts";

const props = { requestId: "request", durationSec: 640, currentTime: 312, initialTime: 312, draftPin: null, pinMode: false,
  onTogglePinMode: () => {}, onClearPin: () => {}, onPosted: vi.fn(), canPin: false };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function post() {
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Scout the third base before moving out." } });
  fireEvent.submit(screen.getByRole("form", { name: "Write a review comment" }));
}
beforeEach(() => {
  localStorage.clear(); h.auth.userId = "A"; h.auth.isLoaded = true; h.auth.isSignedIn = true;
  h.auth.getToken.mockReset().mockImplementation(async () => `${h.auth.userId}-token`); props.onPosted.mockReset();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("restores only the current account's draft across A→B→A and hides during auth loading", () => {
  saveDraft("A", "request", null, { body: "Private advice from account A.", start: 120, end: null });
  saveDraft("B", "request", null, { body: "Different advice from account B.", start: 240, end: null });
  const view = render(<ReviewComposer {...props} />);
  expect(screen.getByLabelText("Comment")).toHaveProperty("value", "Private advice from account A.");
  h.auth.userId = "B"; view.rerender(<ReviewComposer {...props} />);
  expect(screen.getByLabelText("Comment")).toHaveProperty("value", "Different advice from account B.");
  h.auth.isLoaded = false; view.rerender(<ReviewComposer {...props} />); expect(screen.queryByLabelText("Comment")).toBeNull();
  h.auth.isLoaded = true; h.auth.userId = "A"; view.rerender(<ReviewComposer {...props} />);
  expect(screen.getByLabelText("Comment")).toHaveProperty("value", "Private advice from account A.");
});

it("does not send a held token after switching accounts", async () => {
  const token = deferred<string>(); h.auth.getToken.mockReturnValueOnce(token.promise);
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "comment" }))); vi.stubGlobal("fetch", fetcher);
  const view = render(<ReviewComposer {...props} />); post();
  await waitFor(() => expect(h.auth.getToken).toHaveBeenCalledOnce());
  h.auth.userId = "B"; view.rerender(<ReviewComposer {...props} />);
  await act(async () => token.resolve("B-token"));
  expect(fetcher).not.toHaveBeenCalled(); expect(props.onPosted).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Comment")).toHaveProperty("value", "");
});

it("ignores a held response through A→B→A without clearing A's saved draft or the new editor", async () => {
  const body = deferred<{ id: string }>();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: () => body.promise })));
  saveDraft("A", "request", null, { body: "Private advice from account A.", start: 120, end: null });
  const view = render(<ReviewComposer {...props} />); post();
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  h.auth.userId = "B"; view.rerender(<ReviewComposer {...props} />);
  h.auth.userId = "A"; view.rerender(<ReviewComposer {...props} />);
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Newer private advice from account A." } });
  await act(async () => body.resolve({ id: "old-comment" }));
  expect(props.onPosted).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Comment")).toHaveProperty("value", "Newer private advice from account A.");
  expect(loadDraft("A", "request")?.body).toBe("Private advice from account A.");
});
