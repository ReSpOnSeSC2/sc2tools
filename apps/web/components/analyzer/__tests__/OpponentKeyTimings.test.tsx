import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OpponentKeyTimings } from "../OpponentKeyTimings";
import type { DossierAnalysis, DossierTimingRow } from "@/lib/dossierTypes";
vi.mock("@/components/ui/Icon", () => ({ Icon: () => <span /> }));
afterEach(cleanup);
const row: DossierTimingRow = { source: "opp_build_log", sampleCount: 2, medianSeconds: 665, medianDisplay: "11:05 recorded", p25Seconds: 590, p25Display: "9:50 given", p75Seconds: 700, p75Display: "11:40 given", lastSeenDisplay: "12:00 last", trend: "earlier", winRateWhenBuilt: 0.5, samples: [{ gameId: "g1" }, { gameId: "g2" }] };
const analysis: DossierAnalysis = { medianTimingsLegacy: { Hive: row, Nexus: { ...row, source: "build_log", medianDisplay: "2:00 own" }, OneOff: { ...row, sampleCount: 1 } }, medianTimingsOrder: ["Hive", "Nexus", "OneOff"], matchupTimingsLegacy: { PvZ: { timings: { Hive: row }, order: ["Hive"] } }, buildOrdersAvailable: 4, yourBuildOrdersAvailable: 7, buildOrdersTotal: 9 };
describe("opponent key timings", () => {
  it("preserves server clocks, clamps quartiles, names trends/n and sends the bounded analyzed cohort", () => {
    const select = vi.fn(); const view = render(<OpponentKeyTimings analysis={analysis} onSelect={select} />);
    expect(screen.getByText("Needs build orders: 4 of 9 games have one.")).toBeTruthy(); expect(screen.queryByText("OneOff")).toBeNull(); expect(screen.getByText("11:05 recorded · n=2")).toBeTruthy();
    expect(screen.getByRole("img", { name: /Middle half 9:50 given to 11:40 given; median 11:05 recorded/ })).toBeTruthy(); expect(view.container.querySelector('[style*="left: 100%"]')).toBeTruthy();
    expect(screen.getByText("↘ getting earlier")).toBeTruthy(); expect(screen.getByText("Your win rate when built: 50% (n=2)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Hive 11:05/ })); expect(select).toHaveBeenLastCalledWith({ token: "Hive", label: "Hive", source: "opp_build_log", gameIds: ["g1", "g2"] });
    fireEvent.click(screen.getByRole("button", { name: "PvZ" })); fireEvent.click(screen.getByRole("button", { name: /^Hive 11:05/ })); expect(select.mock.calls.at(-1)![0].matchup).toBe("PvZ");
    fireEvent.click(screen.getByRole("button", { name: "All matchups" })); fireEvent.click(screen.getByRole("button", { name: "Yours" })); expect(screen.getByText("2:00 own · n=2")).toBeTruthy(); expect(screen.queryByText("Hive")).toBeNull(); expect(screen.getByText("Needs build orders: 7 of 9 games have one.")).toBeTruthy();
  });
  it("keeps missing replay IDs unavailable and clears an externally selected row", () => {
    const select = vi.fn(); const view = render(<OpponentKeyTimings analysis={{ medianTimingsLegacy: { Hive: { ...row, samples: [] } } }} onSelect={select} />);
    expect(screen.getByRole("button", { name: /^Hive/ }).hasAttribute("disabled")).toBe(true); expect(screen.getByText("Analyzed replay links unavailable")).toBeTruthy();
    view.rerender(<OpponentKeyTimings analysis={analysis} selected={{ token: "Hive", label: "Hive", source: "opp_build_log", gameIds: ["g1"] }} onSelect={select} />);
    const button = screen.getByRole("button", { name: /^Hive/ }); expect(button.getAttribute("aria-pressed")).toBe("true"); fireEvent.click(button); expect(select).toHaveBeenCalledWith(null);
  });
});
