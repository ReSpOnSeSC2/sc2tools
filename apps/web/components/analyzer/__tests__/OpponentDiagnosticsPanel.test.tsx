import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ call: vi.fn(), mutate: vi.fn(async () => undefined) }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "token" }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: (...args: unknown[]) => h.call(...args), useApi: () => ({ data: {
  pulseIdStatus: "unresolved", mmrStatus: "missing", mmr: null, region: "EU", inReplayMmrCount: 12, gameCount: 30,
  pulseCharacterId: null, toonHandle: "2-S2-1-123", findings: [],
}, isLoading: false, mutate: h.mutate }) }));
import { OpponentDiagnosticsPanel, pulseRetrySummary } from "../OpponentDiagnosticsPanel";
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("uses a controlled accessible disclosure, plain summary, and a loading retry button", async () => {
  let finish!: (response: unknown) => void;
  h.call.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const onRetried = vi.fn(); render(<OpponentDiagnosticsPanel collapsible diagnosticsPath="/diagnostics" retryPath="/retry" onRetried={onRetried} />);
  const disclosure = screen.getByRole("button", { name: /Identity.*diagnostics/ });
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(disclosure); expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(disclosure.getAttribute("aria-controls")!)).toBeTruthy();
  expect(screen.getByText("12 of 30")).toBeTruthy(); expect(screen.getByText("Not found yet")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry SC2Pulse" }));
  expect(screen.getByRole("button", { name: /Retrying/ }).getAttribute("aria-busy")).toBe("true");
  const response = { resolvedPulseCharacterId: true, mmr: 4812, region: "EU", gamesRestamped: 3, pulseCharacterId: "123" };
  await act(async () => finish(response));
  expect(onRetried).toHaveBeenCalledWith(response); expect(h.mutate).toHaveBeenCalledOnce();
  expect(screen.getByText("Found their SC2Pulse profile · MMR 4,812 (EU) · Updated 3 past games")).toBeTruthy();
});
it("explains missing ladder MMR separately from an unresolved player", () => {
  const response = { resolvedPulseCharacterId: true, mmr: null, region: null, gamesRestamped: 0, pulseCharacterId: "123" };
  expect(pulseRetrySummary(response)).toContain("no current ladder MMR");
  expect(pulseRetrySummary({ ...response, resolvedPulseCharacterId: false })).toContain("doesn't list this player yet");
});
