import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildInstantReport } from "@/lib/instant/report";
import { realWin } from "@/lib/instant/__tests__/fixtures/reportGames";
import { ShareReportDialog } from "../ShareReportDialog";
import { OpenersCard } from "../report/OpenersCard";
import { InstantReport } from "../InstantReport";

const mocks = vi.hoisted(() => ({ event: vi.fn(), copied: vi.fn(), shared: vi.fn(), canShare: vi.fn(() => true) }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: mocks.event }));
vi.mock("../report/LazyGamesSection", () => ({ LazyGamesSection: () => null }));
const source = () => buildInstantReport([0, 1, 2].map((index) => ({ ...realWin(), gameId: `local-${index}` })), new Date("2026-10-01T00:00:00Z"));

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mocks.copied } });
  Object.defineProperty(navigator, "share", { configurable: true, value: mocks.shared });
  Object.defineProperty(navigator, "canShare", { configurable: true, value: mocks.canShare });
  mocks.shared.mockResolvedValue(undefined); mocks.copied.mockResolvedValue(undefined); mocks.canShare.mockReturnValue(true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ createLinearGradient: () => ({ addColorStop() {} }), fillRect() {}, fillText() {}, measureText: () => ({ width: 20 }) } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["mockpng"], { type: "image/png" })));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("report conversion actions", () => {
  it("previews selected rows, copies identity-free text and mocks native sharing only", async () => {
    render(<ShareReportDialog report={source()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Macro score" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy text" }));
    await screen.findByText("Report text copied.");
    const text = mocks.copied.mock.calls[0][0];
    expect(text).toContain("3 games"); expect(text).not.toMatch(/Macro|Squirtuoz|Tourmaline|local-/);
    fireEvent.click(screen.getByRole("button", { name: "Share PNG" }));
    await screen.findByText("Report shared.");
    expect(mocks.shared.mock.calls[0][0].files[0]).toBeInstanceOf(File);
    expect(mocks.event.mock.calls).toEqual([["instant_report_shared", { method: "text" }], ["instant_report_shared", { method: "web_share" }]]);
  });

  it("offers explicit download/text fallback and does not count a cancelled native share", async () => {
    mocks.canShare.mockReturnValue(false);
    render(<ShareReportDialog report={source()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Share PNG" }));
    await screen.findByText("Use Download PNG or Copy text on this browser.");
    expect(mocks.shared).not.toHaveBeenCalled(); expect(mocks.event).not.toHaveBeenCalled();
    mocks.canShare.mockReturnValue(true); mocks.shared.mockRejectedValue(new DOMException("cancelled", "AbortError"));
    fireEvent.click(screen.getByRole("button", { name: "Share PNG" }));
    await screen.findByText("Sharing cancelled."); expect(mocks.event).not.toHaveBeenCalled();
  });

  it("downloads a local PNG only after the explicit mocked action", async () => {
    const create = vi.fn((_blob: Blob) => "blob:synthetic-report"), revoke = vi.fn(), click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
    render(<ShareReportDialog report={source()} onClose={vi.fn()} />);
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download PNG" }));
    await screen.findByText("PNG downloaded.");
    expect(create.mock.calls[0][0]).toBeInstanceOf(Blob); expect(click).toHaveBeenCalledTimes(1);
    expect(mocks.event).toHaveBeenCalledWith("instant_report_shared", { method: "download" });
  });

  it("refuses a held PNG after the report changes and never launches old native delivery", async () => {
    let complete!: BlobCallback;
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation((callback) => { complete = callback; });
    const view = render(<ShareReportDialog report={source()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Share PNG" }));
    expect(screen.getByRole("checkbox", { name: "Totals" }).matches(":disabled")).toBe(true);
    const replacement = source(); replacement.totals = { games: 0, wins: 0, losses: 0 };
    view.rerender(<ShareReportDialog report={replacement} onClose={vi.fn()} />);
    await act(async () => { complete(new Blob(["oldpng"], { type: "image/png" })); });
    expect(mocks.shared).not.toHaveBeenCalled(); expect(mocks.event).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Totals" }).matches(":disabled")).toBe(false);
  });

  it("scrolls only a matching row under explicit validated focus and preserves ordinary mounting", async () => {
    const report = source(), scroll = vi.fn();
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    Element.prototype.scrollIntoView = scroll;
    const link = { name: "PvZ - Adept Glaives (Robo)", matchup: "PvZ", kind: "build" as const, href: "/guides/pvz/adept-glaives-robo", key: "pvz/adept-glaives-robo" };
    const view = render(<OpenersCard rows={report.openers} games={report.games} guideLinks={[link]} />);
    expect(scroll).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: link.name }).getAttribute("href")).toBe(link.href);
    view.rerender(<OpenersCard rows={report.openers} games={report.games} guideLinks={[link]} guideFocus={{ name: link.name, matchup: link.matchup, key: link.key }} />);
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: "center", behavior: "auto" }));
    expect(document.activeElement?.getAttribute("data-guide-focus")).toBe("true");
    vi.unstubAllGlobals();
  });

  it("retains the actual explicit opener focus after a fresh-analysis parent focus effect", () => {
    const report = source(), scroll = vi.fn();
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    Element.prototype.scrollIntoView = scroll;
    const focus = { name: "PvZ - Adept Glaives (Robo)", matchup: "PvZ", key: "pvz/adept-glaives-robo" };
    const view = render(<><button>Intake control</button><InstantReport report={report} focusKey={1} guideFocus={focus} /></>);
    expect(document.activeElement?.getAttribute("data-guide-focus")).toBe("true");
    expect(scroll).toHaveBeenCalledTimes(1);
    screen.getByRole("button", { name: "Intake control" }).focus();
    view.rerender(<><button>Intake control</button><InstantReport report={report} focusKey={2} guideFocus={focus} /></>);
    expect(document.activeElement?.getAttribute("data-guide-focus")).toBe("true");
    expect(scroll).toHaveBeenCalledTimes(2);
    const intake = screen.getByRole("button", { name: "Intake control" }); intake.focus();
    view.rerender(<><button>Intake control</button><InstantReport report={report} focusKey={2} /></>);
    expect(document.activeElement).toBe(intake);
    expect(scroll).toHaveBeenCalledTimes(2);
    view.rerender(<><button>Intake control</button><InstantReport report={report} focusKey={2} guideFocus={focus} /></>);
    expect(document.activeElement?.getAttribute("data-guide-focus")).toBe("true");
    expect(scroll).toHaveBeenCalledTimes(3);
  });
});
