import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_BUILD_PROFILE, DEFAULT_STUDIO_STATE } from "@/lib/multichat/useStudioState";
import { DockClient } from "../DockClient";
vi.mock("@/lib/multichat/useStudioUpdates", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/multichat/useStudioUpdates")>(),
  useStudioUpdates: () => undefined,
}));

vi.mock("@/lib/multichat/useMultiChat", () => ({ useMultiChat: () => ({ messages: [], events: [], statuses: {}, active: false }) }));
vi.mock("@/lib/multichat/useEngagementReporter", () => ({ useEngagementReporter: () => undefined }));

const TEST_PROFILE = {
  ...DEFAULT_BUILD_PROFILE,
  title: "Test build",
  ratings: { aggressiveness: 4, defensiveness: 2, executionDifficulty: 3, popularity: 1, micro: 5 },
  visible: true,
};
const STUDIO = { ...DEFAULT_STUDIO_STATE, buildProfile: TEST_PROFILE, updatedAt: "2026-10-14T12:00:00.000Z" };
async function drain() {
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Dock build-profile controls", () => {
  it("keeps Hide authoritative when an older poll completes after the POST", async () => {
    vi.useFakeTimers();
    let studioGets = 0;
    let finishOldGet: ((response: unknown) => void) | undefined;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/config")) return { ok: true, json: async () => ({ config: {} }) };
      if (url.includes("/studio") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ buildProfile: { visible: false } });
        return { ok: true, json: async () => ({ ...STUDIO, buildProfile: { ...TEST_PROFILE, visible: false }, updatedAt: "2026-10-14T12:01:00.000Z" }) };
      }
      if (url.includes("/studio")) {
        studioGets++;
        if (studioGets === 1) return { ok: true, json: async () => STUDIO };
        return new Promise((resolve) => { finishOldGet = resolve; });
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DockClient token="test-token" />);
    await drain();
    expect((screen.getByRole("button", { name: "Hide widget" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(studioGets).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Hide widget" }));
    await drain();
    expect((screen.getByRole("button", { name: "Show widget" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { finishOldGet?.({ ok: true, json: async () => STUDIO }); });
    await drain();
    expect((screen.getByRole("button", { name: "Show widget" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Hide widget" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("retains edited wording and rating when the Dock save fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/config")) return { ok: true, json: async () => ({ config: {} }) };
      if (url.includes("/studio") && init?.method === "POST") return { ok: false, status: 503 };
      return { ok: true, json: async () => url.includes("/studio") ? STUDIO : {} };
    }));
    render(<DockClient token="test-token" />);
    await drain();
    fireEvent.change(screen.getByRole("textbox", { name: "Micro required label" }), { target: { value: "Unit control" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Micro required" }), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ratings" }));
    await drain();
    expect(screen.getByText(/Save failed \(503\)/)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Micro required label" }) as HTMLInputElement).value).toBe("Unit control");
    expect((screen.getByRole("combobox", { name: "Micro required" }) as HTMLSelectElement).value).toBe("2");
    expect((screen.getByRole("button", { name: "Hide widget" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
