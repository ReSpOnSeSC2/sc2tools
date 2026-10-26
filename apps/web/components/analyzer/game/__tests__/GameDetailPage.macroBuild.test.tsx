import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { BUILD_ORDER, confirmedResponse, intent, opponentState } from "@/components/build-checkin/__tests__/cardFixtures";
import type { GameIntentState } from "@/lib/buildIntent";

const h = vi.hoisted(() => ({ getToken: vi.fn(async () => "synthetic-owner"), writes: [] as Array<Record<string, unknown>>, reads: [] as string[], state: undefined as GameIntentState | undefined, hold: false, release: null as (() => void) | null }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "synthetic-owner", getToken: h.getToken }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("next/image", () => ({ default: ({ src, alt }: { src: string; alt: string }) => <span aria-label={alt} data-image={src} /> }));
vi.mock("@/lib/useUserSocket", () => ({ useUserSocket: () => undefined }));

import { BuildCheckInProvider } from "@/components/build-checkin/BuildCheckInProvider";
import { GameDetailPage } from "../GameDetailPage";

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
beforeAll(async () => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  await Promise.all([import("../GameMacroSection"), import("../BuildOrderColumns"), import("../BuildWorkspaceActions"), import("@/components/battleReport/GameBattleReport")]);
});
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  h.reads = []; h.writes = []; h.state = intent({ detected: { name: "Replay classified opener", slug: null, key: null }, opponent: opponentState() });
  h.hold = false; h.release = null;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/games/g1/build-intent") {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)); h.writes.push(body);
        if (h.hold) await new Promise<void>(resolve => { h.release = resolve; });
        h.state = body.action === "skip"
          ? intent({ status: "skipped", applied: false, build: null, suggestion: null, opponent: opponentState() })
          : { ...intent({ opponent: opponentState() }), ...confirmedResponse(body.buildKey, "DT into 3 Gate") };
        h.state.detected = { name: "Replay classified opener", slug: null, key: null };
      }
      return json(h.state);
    }
    h.reads.push(url.pathname);
    if (url.pathname === "/v1/games/g1") return json({ gameId: "g1", myRace: "Protoss", myBuild: "Replay classified opener", durationSec: 842, macroScore: 75, result: "Victory", map: "Ephemeron", opponent: { displayName: "Foe", race: "Zerg" } });
    if (url.pathname.endsWith("/build-order")) return json({ ok: true, game_id: "g1", ...BUILD_ORDER });
    if (url.pathname === "/v1/games/vod-links") return json({ linksByGameId: {} });
    return json({ error: { code: url.pathname.endsWith("/macro-breakdown") ? "macro_not_computed" : "not_found", message: "No synthetic payload" } }, 404);
  }));
});
afterEach(() => { h.release?.(); cleanup(); vi.unstubAllGlobals(); });

function renderGame() {
  render(<SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false, revalidateOnFocus: false, dedupingInterval: 0 }}><BuildCheckInProvider><GameDetailPage gameId="g1" /></BuildCheckInProvider></SWRConfig>);
}

describe("Game Macro build editing with real SWR, card and action consumers", () => {
  it("changes the planned build from Macro and updates the original card and real game header", async () => {
    renderGame();
    await screen.findByRole("button", { name: "Change build" });
    const overview = document.getElementById("overview")!;
    expect(within(overview).getByText("Replay classified opener")).toBeTruthy();
    const initialSummaryReads = h.reads.filter(path => path === "/v1/games/g1").length;
    fireEvent.click(screen.getByRole("button", { name: "Change build" }));
    const macro = document.getElementById("macro")!;
    const card = await within(macro).findByTestId("build-checkin-card");
    expect(within(card).getByRole("heading", { name: "Build check-in", level: 4 })).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Change…" }));
    fireEvent.click(within(card).getAllByRole("option").find(node => node.getAttribute("data-build-key") === "custom:dt-3-gate")!);
    h.hold = true;
    fireEvent.click(within(card).getByRole("button", { name: "Confirm DT into 3 Gate" }));
    await waitFor(() => expect(h.release).toBeTypeOf("function"));
    const originalCard = screen.getAllByTestId("build-checkin-card").find(node => !macro.contains(node))!;
    expect((within(originalCard).getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(card).getByRole("button", { name: "Confirm DT into 3 Gate" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(originalCard).getByRole("button", { name: "No set build" }));
    expect(h.writes).toHaveLength(1);
    await act(async () => { h.release?.(); });
    await waitFor(() => expect(within(overview).getByText("DT into 3 Gate")).toBeTruthy());
    expect(within(overview).getByTestId("planned-badge").getAttribute("title")).toBe("Replay classified as Replay classified opener");
    await waitFor(() => expect(screen.getByTestId("build-checkin-summary").textContent).toContain("DT into 3 Gate"));
    expect(h.writes).toEqual([{ action: "confirm", buildKey: "custom:dt-3-gate" }]);
    expect(h.reads.filter(path => path === "/v1/games/g1").length).toBeGreaterThan(initialSummaryReads);
  });

  it("uses No set build inside Macro and refreshes both cards and header without changing the classifier", async () => {
    renderGame();
    fireEvent.click(await screen.findByRole("button", { name: "Change build" }));
    const macro = document.getElementById("macro")!;
    const card = await within(macro).findByTestId("build-checkin-card");
    fireEvent.click(within(card).getByRole("button", { name: "No set build" }));
    await waitFor(() => expect(h.writes).toEqual([{ action: "skip" }]));
    await waitFor(() => expect(screen.getAllByText("No set build. This game keeps the replay's own label.")).toHaveLength(2));
    const overview = document.getElementById("overview")!;
    expect(within(overview).queryByTestId("planned-badge")).toBeNull();
    expect(within(overview).getByText("Replay classified opener")).toBeTruthy();
  });
});
