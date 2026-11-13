import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamViewer } from "../StreamViewer";
import { parseStreamViewer, type StreamViewerPage } from "@/lib/streamViewer";
import { sanitisePagePath } from "@/lib/feedback/sanitise";

const HANDLE = "private-fixture-0123456789";
const initial: StreamViewerPage = { delayMinutes: 5, wins: 1, losses: 0,
  games: [{ result: "win", opponentRace: "Protoss", map: "Deathaura LE" }] };
const empty: StreamViewerPage = { delayMinutes: 5, wins: 0, losses: 0, games: [] };

let visibility: DocumentVisibilityState;
const fetcher = vi.fn();

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  fireEvent(document, new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  fetcher.mockReset();
  vi.stubGlobal("fetch", fetcher);
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("stream viewer", () => {
  it("polls the direct anonymous endpoint every 60 seconds only while visible", async () => {
    fetcher.mockImplementationOnce(async () => Response.json(initial)).mockImplementation(async () => Response.json(empty));
    render(<StreamViewer handle={HANDLE} />);
    expect(screen.getByRole("status", { name: "Checking the viewer page" })).toBeTruthy();
    expect(screen.queryByText("vs. Protoss")).toBeNull();
    await advance(0);
    expect(screen.getByText("vs. Protoss")).toBeTruthy();
    await advance(59_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    setVisibility("hidden");
    await advance(60_001);
    expect(fetcher).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    expect(screen.getByRole("status", { name: "Checking the viewer page" })).toBeTruthy();
    expect(screen.queryByText("vs. Protoss")).toBeNull();
    await advance(0);
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining(`/v1/public/players/${HANDLE}/live`),
      expect.objectContaining({ cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" }));
    expect(screen.getByText("No delayed results are available for this session yet.")).toBeTruthy();
    await advance(59_999);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("clears results after a 404 and restores them only after a successful retry", async () => {
    fetcher.mockResolvedValueOnce(Response.json(initial)).mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json(initial));
    render(<StreamViewer handle={HANDLE} />);
    await advance(0);
    expect(screen.getByText("vs. Protoss")).toBeTruthy();
    await advance(60_000);
    expect(screen.getByText("This page is no longer shared.")).toBeTruthy();
    expect(screen.queryByText("vs. Protoss")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await advance(0);
    expect(screen.getByText("vs. Protoss")).toBeTruthy();
  });

  it("clears stale results on a failed deadline and ignores a response retired by visibility", async () => {
    let retired: (response: Response) => void = () => {};
    fetcher.mockImplementationOnce(() => new Promise(resolve => { retired = resolve; }))
      .mockImplementationOnce((_url: string, { signal }: RequestInit) => new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")));
      }));
    render(<StreamViewer handle={HANDLE} />);
    const first = fetcher.mock.calls[0][1].signal as AbortSignal;
    setVisibility("hidden");
    expect(first.aborted).toBe(true);
    setVisibility("visible");
    await act(async () => retired(Response.json(initial)));
    expect(screen.queryByText("vs. Protoss")).toBeNull();
    await advance(8000);
    expect(screen.getByText("The latest results couldn't load.")).toBeTruthy();
    expect(screen.queryByText("vs. Protoss")).toBeNull();
  });

  it("clears the saved document before back-forward cache and rechecks on restore", async () => {
    fetcher.mockResolvedValueOnce(Response.json(initial)).mockResolvedValueOnce(new Response(null, { status: 404 }));
    render(<StreamViewer handle={HANDLE} />);
    await advance(0);
    expect(screen.getByText("vs. Protoss")).toBeTruthy();
    fireEvent(window, new PageTransitionEvent("pagehide", { persisted: true }));
    expect(screen.queryByText("vs. Protoss")).toBeNull();
    fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true }));
    await advance(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByText("This page is no longer shared.")).toBeTruthy();
  });

  it("waits to check publication when mounted in a hidden tab", async () => {
    visibility = "hidden";
    fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }));
    render(<StreamViewer handle={HANDLE} />);
    await advance(60_000);
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.queryByText("vs. Protoss")).toBeNull();
    setVisibility("visible");
    await advance(0);
    expect(screen.getByText("This page is no longer shared.")).toBeTruthy();
  });
});

it("projects only public response fields and rejects impossible or invalid values", () => {
  expect(parseStreamViewer({ ...initial, handle: HANDLE, games: initial.games.map(game => ({ ...game, name: "private" })) })).toEqual(initial);
  expect(parseStreamViewer({ ...initial, delayMinutes: 4 })).toBeNull();
  expect(parseStreamViewer({ ...initial, wins: 0 })).toBeNull();
  expect(parseStreamViewer({ ...initial, games: [{ ...initial.games[0], opponentRace: "private" }] })).toBeNull();
});

it("keeps viewer handles and queries out of the feedback page path", () => {
  expect(sanitisePagePath(`/p/${HANDLE}/live?private=value`)).toBe("/p/[redacted]/live");
});
