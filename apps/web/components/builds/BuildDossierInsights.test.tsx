import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuildDossierInsightsData, BuildPlan } from "@/lib/buildDossierInsights";
import { timingAxis } from "@/lib/buildDossierInsights";
import { KeyTimingsCard } from "./KeyTimingsCard";
import { PlanSurvivalCard } from "./PlanSurvivalCard";

vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ slug, anchor }: { slug: string; anchor: string }) => <a href={`/help/${slug}#${anchor}`}>Help</a> }));
vi.mock("@/components/ui/Icon", () => ({ Icon: () => null }));
afterEach(cleanup);

function timings(): BuildDossierInsightsData {
  const row = { source: "build_log" as const, sampleCount: 12, medianSeconds: 300, p25Seconds: 280, p75Seconds: 320,
    displayName: "Stargate", trend: "earlier" as const, winRateWhenBuilt: 0.5, winRateSampleCount: 10,
    winnerMedianSeconds: 290, loserMedianSeconds: 310, winnerSampleCount: 5, loserSampleCount: 5,
    samples: [{ gameId: "older-game" }, { gameId: "recent-game" }] };
  return { timingSampleGames: 25, timingSampleSelected: 25, timingSampleLimit: 25, timingsTruncated: true, medianTimingsOrder: ["Stargate", "Gateway"],
    matchupTimingsLegacy: { PvZ: { order: ["Stargate", "Gateway"], timings: { Gateway: { ...row, displayName: "Gateway" }, Stargate: row, SpawningPool: { ...row, displayName: "Spawning Pool", source: "opp_build_log" } } },
      PvT: { order: ["Gateway"], timings: { Gateway: { ...row, displayName: "Gateway", samples: [{ gameId: "pvt-game" }] } } } },
    communityTimings: { PvZ: { href: "/guides/pvz/stargate", era: "after", computedAt: "2026-10-01T00:00:00Z",
      rows: [{ token: "Stargate", p25Seconds: 270, medianSeconds: 288, p75Seconds: 295, sampleCount: 80, users: 30, event: "start" }] } } };
}

const plan = (): BuildPlan => ({ declared: 8, held: 5, knockedOff: 3, heldRate: 5 / 8, heldWR: 0.6, knockedOffWR: 0,
  heldDecided: 5, knockedOffDecided: 2, knockedInto: [{ name: "Ground follow-up", count: 30, sampleGameIds: ["sample-1", "sample-2"], sampleLimit: 20, sampleTruncated: true }],
  knockedBy: [{ name: "Roach pressure", count: 3, sampleGameIds: ["sample-3"], sampleLimit: 20, sampleTruncated: false }],
  medianKnockedOffDurationSec: 700, durationSamples: 3, durationEstimated: true });

describe("Key timings", () => {
  it("preserves timing order, quantified observations, outcome thresholds and exact Community comparison", () => {
    render(<KeyTimingsCard data={timings()} onSelect={vi.fn()} />);
    const rows = within(screen.getByRole("list", { name: "Build key timing rows" })).getAllByRole("listitem");
    expect(rows[0].textContent).toContain("Stargate"); expect(rows[1].textContent).toContain("Gateway");
    expect(screen.getByText(/Based on your last 25 eligible games/)).toBeTruthy();
    expect(within(rows[0]).getByRole("img").getAttribute("aria-label")).toContain("Middle half 4:40 to 5:20; median 5:00");
    expect(within(rows[0]).getByText("Your WR when built: 50.0% · 10 decided")).toBeTruthy();
    expect(within(rows[0]).getByText(/Your wins: 4:50 median \(n=5\) · Your losses: 5:10 median \(n=5\)/)).toBeTruthy();
    expect(screen.getByText("12 s slower than community")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Community guide" }).getAttribute("href")).toBe("/guides/pvz/stargate");
    expect(screen.getByRole("link", { name: "Help" }).getAttribute("href")).toBe("/help/custom-builds#key-timings");
  });
  it("selects the exact matchup sample and never applies your Community band to opponent timings", () => {
    const select = vi.fn(); render(<KeyTimingsCard data={timings()} onSelect={select} />);
    fireEvent.click(screen.getByRole("button", { name: /Stargate/ }));
    expect(select).toHaveBeenLastCalledWith(["older-game", "recent-game"], "Stargate timings · PvZ");
    fireEvent.click(screen.getByRole("button", { name: "Opponent timings" }));
    expect(screen.queryByText(/slower than community/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Community guide" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Spawning Pool/ }));
    expect(select).toHaveBeenLastCalledWith(["older-game", "recent-game"], "Spawning Pool timings · PvZ");
    fireEvent.click(screen.getByRole("button", { name: "Your timings" }));
    fireEvent.click(screen.getByRole("button", { name: "PvT" }));
    fireEvent.click(screen.getByRole("button", { name: /Gateway/ }));
    expect(select).toHaveBeenLastCalledWith(["pvt-game"], "Gateway timings · PvT");
  });
  it("withholds small outcomes and missing comparisons while preserving zero measured win rate", () => {
    const data = timings(); const row = data.matchupTimingsLegacy!.PvZ.timings.Stargate;
    row.loserSampleCount = 4; row.winRateWhenBuilt = 0; row.winRateSampleCount = 5;
    delete data.matchupTimingsLegacy!.PvZ.timings.Gateway; data.communityTimings = {};
    render(<KeyTimingsCard data={data} onSelect={vi.fn()} />);
    expect(screen.queryByText(/Your wins:.*median/)).toBeNull();
    expect(screen.getByText("Your WR when built: 0.0% · 5 decided")).toBeTruthy();
    expect(screen.queryByText(/Community:/)).toBeNull();
  });
  it("handles unknown timing rows without inventing logs or a capped ten-minute axis", () => {
    const data = timings(); data.matchupTimingsLegacy!.PvZ.timings.Stargate.p75Seconds = 1200;
    render(<KeyTimingsCard data={data} onSelect={vi.fn()} />);
    expect(screen.getAllByText("20:00").length).toBeGreaterThan(0);
    cleanup(); render(<KeyTimingsCard data={{}} onSelect={vi.fn()} />);
    expect(screen.getByText(/Not enough recorded timings/)).toBeTruthy();
    expect(screen.getByText(/Recent eligible timing sample \(up to 25 games\)/)).toBeTruthy();
    expect(screen.queryByText(/0 games with/)).toBeNull();
    expect(timingAxis([NaN, Infinity, -1, 610])).toBe(660);
  });
  it("reports actual selected and logged coverage when check-ins leave fewer than25 eligible games", () => {
    render(<KeyTimingsCard data={{ ...timings(), timingSampleSelected: 5, timingSampleGames: 3 }} onSelect={vi.fn()} />);
    expect(screen.getByText(/Based on your last 5 eligible games \(up to 25\); 3 had recorded timing logs/)).toBeTruthy();
    expect(screen.queryByText(/Based on your last 25 eligible games/)).toBeNull();
  });
});

describe("Plan survival", () => {
  it("hides fewer than five declarations and inconsistent cohort counts", () => {
    const view = render(<PlanSurvivalCard plan={{ ...plan(), declared: 4, held: 1 }} onSelect={vi.fn()} />);
    expect(screen.queryByText("Plan survival")).toBeNull();
    view.rerender(<PlanSurvivalCard plan={{ ...plan(), declared: 6 }} onSelect={vi.fn()} />);
    expect(screen.queryByText("Plan survival")).toBeNull();
  });
  it("keeps zero win rate and unknown distinct, links only recorded examples and explains duration", () => {
    const select = vi.fn(); const data = plan(); data.heldWR = null; data.heldDecided = 0;
    render(<PlanSurvivalCard plan={data} onSelect={select} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("5 held and 3 knocked off among 8 declared games");
    expect(screen.getByText("Unavailable")).toBeTruthy(); expect(screen.getByText("0.0%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Ground follow-up/ }));
    expect(select).toHaveBeenCalledWith(["sample-1", "sample-2"], "Knocked into: Ground follow-up");
    fireEvent.click(screen.getByRole("button", { name: /Roach pressure/ }));
    expect(select).toHaveBeenLastCalledWith(["sample-3"], "Knocked by opponent strategy: Roach pressure");
    expect(screen.getByText(/Estimated median full game length when knocked off: 11:40/)).toBeTruthy();
    expect(screen.getByText(/This is not the time the plan changed/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Help" }).getAttribute("href")).toBe("/help/build-check-in#plan-survival");
  });
});
