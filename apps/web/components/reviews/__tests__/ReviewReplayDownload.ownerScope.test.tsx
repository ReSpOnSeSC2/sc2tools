import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: true, userId: "A" as string | null, getToken: vi.fn<() => Promise<string | null>>() },
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => h.auth }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: vi.fn() }));

import { ReviewReplayDownload } from "../ReviewReplayDownload";

const props = { requestId: "AAAAAAAAAAAAAAAA", requestUrl: "/reviews/AAAAAAAAAAAAAAAA", variant: "page" as const };
const payload = { url: "https://replay.example/signed", filename: "sc2tools-review-AAAAAAAAAAAAAAAA.SC2Replay", expiresIn: 300 };
const clicked: Array<{ href: string; filename: string; rel: string; referrerPolicy: string }> = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function start() { fireEvent.click(screen.getByRole("button", { name: "Download replay", exact: true })); }

beforeEach(() => {
  clicked.length = 0;
  h.auth.isLoaded = true; h.auth.isSignedIn = true; h.auth.userId = "A";
  h.auth.getToken.mockReset().mockImplementation(async () => `${h.auth.userId}-token`);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, filename: this.download, rel: this.rel, referrerPolicy: this.referrerPolicy });
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(["switch", "unmount"])("never fetches or clicks a replay download held at JWT lookup after %s", async (transition) => {
  const token = deferred<string>(); h.auth.getToken.mockReturnValueOnce(token.promise);
  const fetcher = vi.fn(async () => new Response(JSON.stringify(payload))); vi.stubGlobal("fetch", fetcher);
  const view = render(<ReviewReplayDownload {...props} />); start();
  await waitFor(() => expect(h.auth.getToken).toHaveBeenCalledOnce());
  if (transition === "switch") {
    h.auth.userId = "B"; view.rerender(<ReviewReplayDownload {...props} />);
    expect(screen.getByRole("button", { name: "Download replay", exact: true })).toHaveProperty("disabled", false);
  } else view.unmount();
  await act(async () => token.resolve("B-token"));
  expect(fetcher).not.toHaveBeenCalled(); expect(clicked).toEqual([]);
  expect(screen.queryByRole("status")).toBeNull();
});

it.each(["switch", "unmount"])("never clicks a replay download held in its response body after %s", async (transition) => {
  const body = deferred<typeof payload>(); const json = vi.fn(() => body.promise);
  const fetcher = vi.fn(async () => ({ ok: true, status: 200, json })); vi.stubGlobal("fetch", fetcher);
  const view = render(<ReviewReplayDownload {...props} />); start();
  await waitFor(() => expect(json).toHaveBeenCalledOnce());
  if (transition === "switch") {
    h.auth.userId = "B"; view.rerender(<ReviewReplayDownload {...props} />);
    h.auth.userId = "A"; view.rerender(<ReviewReplayDownload {...props} />);
    expect(screen.getByRole("button", { name: "Download replay", exact: true })).toHaveProperty("disabled", false);
  } else view.unmount();
  await act(async () => body.resolve(payload));
  expect(fetcher).toHaveBeenCalledOnce(); expect(clicked).toEqual([]);
  expect(screen.queryByRole("status")).toBeNull();
});

it("still fetches one signed link and clicks one neutral, protected download while its owner remains current", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(payload))); vi.stubGlobal("fetch", fetcher);
  render(<ReviewReplayDownload {...props} />); start();
  await waitFor(() => expect(clicked).toHaveLength(1));
  expect(fetcher).toHaveBeenCalledOnce();
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toMatch(/\/v1\/reviews\/AAAAAAAAAAAAAAAA\/replay$/);
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer A-token");
  expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(clicked[0]).toEqual({ href: payload.url, filename: payload.filename, rel: "noopener noreferrer", referrerPolicy: "no-referrer" });
  expect(document.querySelector(`a[download="${payload.filename}"]`)).toBeNull();
  expect(screen.getByRole("button", { name: "Download replay", exact: true })).toHaveProperty("disabled", false);
});

it("retains current download error feedback and rejects an unsafe signed URL without clicking", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...payload, url: "http://replay.example/unsafe" }))));
  render(<ReviewReplayDownload {...props} />); start();
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "The replay download link was invalid.");
  expect(clicked).toEqual([]);
  expect(screen.getByRole("button", { name: "Download replay", exact: true })).toHaveProperty("disabled", false);
});
