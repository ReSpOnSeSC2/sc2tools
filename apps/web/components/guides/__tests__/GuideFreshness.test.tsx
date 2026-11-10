import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GuidesLayout from "@/app/guides/layout";
import { GuideFreshness } from "../GuideFreshness";

const mocks = vi.hoisted(() => ({ router: { refresh: vi.fn() }, seed: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }));
vi.mock("@/lib/guides/revision", () => ({ fetchGuideRevision: mocks.seed }));
const fetchMock = vi.fn();

let visibility: DocumentVisibilityState;
let online: boolean;

function changeVisibility(next: DocumentVisibilityState) {
  visibility = next;
  act(() => document.dispatchEvent(new Event("visibilitychange")));
}

function pageShow(persisted: boolean) {
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: persisted });
  act(() => window.dispatchEvent(event));
}

function settleReturn() {
  act(() => vi.advanceTimersByTime(100));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
  visibility = "visible";
  online = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ revision: "revision-one" }) });
  vi.stubGlobal("fetch", fetchMock);
  mocks.seed.mockResolvedValue("revision-one");
  mocks.router.refresh.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("GuideFreshness", () => {
  it("seeds guide pages without refreshing unchanged content", async () => {
    render(await GuidesLayout({ children: <p>Charge First guide</p> }));
    expect(screen.getByText("Charge First guide")).toBeTruthy();
    pageShow(false);
    changeVisibility("visible");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mocks.router.refresh).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes when a mobile page returns from hidden to visible", () => {
    render(<GuideFreshness initialRevision="revision-one" />);
    changeVisibility("hidden");
    settleReturn();
    expect(mocks.router.refresh).not.toHaveBeenCalled();
    changeVisibility("visible");
    expect(mocks.router.refresh).not.toHaveBeenCalled();
    settleReturn();
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes a page initially opened in the background once visible", () => {
    visibility = "hidden";
    render(<GuideFreshness initialRevision="revision-one" />);
    settleReturn();
    expect(mocks.router.refresh).not.toHaveBeenCalled();
    changeVisibility("visible");
    settleReturn();
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes a restored BFCache page without needing a visibility event", () => {
    render(<GuideFreshness initialRevision="revision-one" />);
    pageShow(true);
    settleReturn();
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
  });

  it("coalesces visibility and BFCache events and ignores rapid duplicates", () => {
    render(<GuideFreshness initialRevision="revision-one" />);
    changeVisibility("hidden");
    pageShow(true);
    changeVisibility("visible");
    pageShow(true);
    settleReturn();
    pageShow(true);
    changeVisibility("hidden");
    changeVisibility("visible");
    settleReturn();
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(2000));
    changeVisibility("hidden");
    changeVisibility("visible");
    settleReturn();
    expect(mocks.router.refresh).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending return refresh if the page is hidden again", () => {
    render(<GuideFreshness initialRevision="revision-one" />);
    changeVisibility("hidden");
    changeVisibility("visible");
    changeVisibility("hidden");
    settleReturn();
    expect(mocks.router.refresh).not.toHaveBeenCalled();
    changeVisibility("visible");
    settleReturn();
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
  });

  it("waits until visible when BFCache restores a background page", () => {
    render(<GuideFreshness initialRevision="revision-one" />);
    visibility = "hidden";
    pageShow(true);
    settleReturn();
    expect(mocks.router.refresh).not.toHaveBeenCalled();
    changeVisibility("visible");
    settleReturn();
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
  });

  it("removes listeners and pending work when leaving the guide layout", () => {
    const { unmount } = render(<GuideFreshness initialRevision="revision-one" />);
    changeVisibility("hidden");
    changeVisibility("visible");
    unmount();
    settleReturn();
    changeVisibility("hidden");
    changeVisibility("visible");
    pageShow(true);
    settleReturn();
    expect(mocks.router.refresh).not.toHaveBeenCalled();
  });
});

async function advanceChecks(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe("guide background revision checks", () => {
  it("refreshes an active guide only when the opaque revision changes", async () => {
    render(<GuideFreshness initialRevision="revision-one" />);
    await advanceChecks(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/v1\/guides\/revision$/);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store", credentials: "omit" });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ revision: "revision-two" }) });
    await advanceChecks(60_100);
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
    await advanceChecks(60_000);
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
  });

  it("detects changes that happened after the server rendered the initial revision", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ revision: "revision-two" }) });
    render(<GuideFreshness initialRevision="revision-one" />);
    await advanceChecks(100);
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not check while hidden or offline, and resumes automatically", async () => {
    visibility = "hidden";
    online = false;
    render(<GuideFreshness initialRevision="revision-one" />);
    await advanceChecks(120_000);
    expect(fetchMock).not.toHaveBeenCalled();
    changeVisibility("visible");
    await advanceChecks(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    online = true;
    act(() => window.dispatchEvent(new Event("online")));
    await advanceChecks(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
  });

  it("aborts a hidden page's check and ignores a late response", async () => {
    let finish!: (value: unknown) => void;
    fetchMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<GuideFreshness initialRevision="revision-one" />);
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    changeVisibility("hidden");
    expect(signal.aborted).toBe(true);
    finish({ ok: true, json: async () => ({ revision: "revision-two" }) });
    await advanceChecks(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.router.refresh).not.toHaveBeenCalled();
  });

  it("times out hung checks and never overlaps them", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    render(<GuideFreshness initialRevision="revision-one" />);
    pageShow(true);
    pageShow(true);
    await advanceChecks(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
    await advanceChecks(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ok: false, json: async () => ({ error: "not_found" }) },
    { ok: true, json: async () => ({ revision: { private: "data" } }) },
    { ok: true, json: async () => { throw new Error("bad_json"); } },
  ])("keeps the page usable when an optional check fails", async (response) => {
    fetchMock.mockResolvedValue(response);
    render(<GuideFreshness initialRevision="revision-one" />);
    await advanceChecks(60_100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.router.refresh).not.toHaveBeenCalled();
  });

  it("aborts and removes polling after leaving Guides", async () => {
    let finish!: (value: unknown) => void;
    fetchMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { unmount } = render(<GuideFreshness initialRevision="revision-one" />);
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    finish({ ok: true, json: async () => ({ revision: "revision-two" }) });
    await advanceChecks(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.router.refresh).not.toHaveBeenCalled();
  });
});
