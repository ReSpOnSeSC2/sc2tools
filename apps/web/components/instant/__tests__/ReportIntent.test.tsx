import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildInstantReport } from "@/lib/instant/report";
import { realWin } from "@/lib/instant/__tests__/fixtures/reportGames";
import { ShareReportButton } from "../ShareReportButton";
import { SampleReportButton } from "../SampleReportButton";
import { projectSampleGame } from "@/lib/instant/sampleReport";
import { INSTANT_ENGINE_VERSION } from "@/lib/instant/engineVersion";

const mocks = vi.hoisted(() => ({ dialogLoaded: vi.fn(), event: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/instant/sampleAvailability.generated", () => ({ SAMPLE_REPORT_AVAILABLE: true }));
vi.mock("../ShareReportDialog", () => { mocks.dialogLoaded(); return { ShareReportDialog: ({ onClose }: { onClose(): void }) => <button onClick={onClose}>Close mocked share preview</button> }; });
vi.mock("../report/LazyGamesSection", () => ({ LazyGamesSection: () => <div>Sample game details</div> }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: mocks.event }));
// Real fixture statistics; transport metadata is mocked so this test also
// runs when optional sample generation is unavailable and its file is absent.
const sample = { schemaVersion: 1, engineVersion: INSTANT_ENGINE_VERSION, engineBundleId: "1234567890abcdef", engineSourceHash: "a".repeat(64), games: [projectSampleGame(realWin())] };
beforeEach(() => {
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockImplementation(async (url: string) => ({ ok: true, json: async () => url === "/engine/current.json" ? { engineVersion: sample.engineVersion, manifest: `/engine/${sample.engineVersion}/${sample.engineBundleId}/manifest.json` } : sample }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });

describe("conversion work starts on intent", () => {
  it("does not load the share renderer or fetch a sample on ordinary mount", async () => {
    const report = buildInstantReport([realWin()], new Date());
    render(<><ShareReportButton report={report} /><SampleReportButton /></>);
    expect(mocks.dialogLoaded).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Share report" }));
    await screen.findByRole("button", { name: "Close mocked share preview" });
    expect(mocks.dialogLoaded).toHaveBeenCalledTimes(1); expect(mocks.fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close mocked share preview" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Share report" }));
    fireEvent.click(screen.getByRole("button", { name: "See a sample report" }));
    await screen.findByRole("heading", { name: "Example results" });
    expect(mocks.fetch.mock.calls.map((call) => call[0]).sort()).toEqual(["/engine/current.json", "/try/sample-payloads.json"]);
    expect(mocks.event).toHaveBeenCalledWith("instant_sample_view");
    expect(screen.queryByText("Save these games")).toBeNull();
  });

  it("settles a held body at the real deadline and keeps Retry explicit", async () => {
    const { SampleReportPreview } = await import("../SampleReportPreview");
    mocks.fetch.mockImplementation(async () => ({ ok: true, json: () => new Promise(() => {}) }));
    vi.useFakeTimers();
    render(<SampleReportPreview />);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(screen.getByRole("button", { name: "Retry sample" })).toBeTruthy();
    expect(mocks.event).not.toHaveBeenCalled();
  });
});
