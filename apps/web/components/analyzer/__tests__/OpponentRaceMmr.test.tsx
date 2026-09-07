import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { HeadlineMmrChip, RaceMmrPanel, type PulseRaceBreakdown } from "../OpponentRaceMmr";
import type { GlobalPlayerIdentity } from "@/lib/opponentGroups";

vi.mock("@/components/ui/Icon", () => ({ Icon: () => <span /> }));
afterEach(cleanup);

const confirmed: GlobalPlayerIdentity = {
  groupKey: "identity:pulse:236671", displayName: "Strange", revision: 1,
  target: { key: "pulse:236671", pulseCharacterId: "236671", toonHandle: "2-S2-2-632713" },
};
const breakdown: PulseRaceBreakdown = {
  resolved: true, topRace: "Protoss", topMmr: 6100,
  races: [{ race: "Protoss", mmr: 6100, games: 80, league: "Grandmaster", region: "EU" }],
  ladderIdentity: { pulseCharacterId: "236671", toonHandle: "2-S2-2-632713", displayName: "Strange", region: "EU", confirmed: true },
};

describe("confirmed player ladder MMR", () => {
  test("shows the main-profile rating and links to the same approved SC2Pulse account", () => {
    render(<><HeadlineMmrChip breakdown={breakdown} fallbackMmr={5275} confirmedIdentity={confirmed} /><RaceMmrPanel breakdown={breakdown} isLoading={false} confirmedIdentity={confirmed} /></>);
    expect(screen.getByRole("note", { name: "Protoss MMR 6100 for Strange's main profile" })).toBeTruthy();
    expect(screen.getByText(/Strange's confirmed main profile/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "View SC2Pulse profile" }).getAttribute("href")).toContain("id=236671");
    expect(screen.queryByText("5,275")).toBeNull();
  });

  test("does not show stale barcode ratings while an approval reloads", () => {
    const stale = { ...breakdown, topRace: "Random", topMmr: 5275, ladderIdentity: { ...breakdown.ladderIdentity!, confirmed: false, pulseCharacterId: "8703807", toonHandle: "2-S2-2-240434" } };
    render(<><HeadlineMmrChip breakdown={stale} fallbackMmr={5275} confirmedIdentity={confirmed} /><RaceMmrPanel breakdown={stale} isLoading={false} confirmedIdentity={confirmed} /></>);
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText("MMR by race")).toBeNull();
  });

  test("unavailable main-profile ratings do not silently substitute recorded-account MMR", () => {
    const unavailable = { ...breakdown, resolved: false, races: [], topMmr: null, topRace: null };
    render(<><HeadlineMmrChip breakdown={unavailable} fallbackMmr={5275} confirmedIdentity={confirmed} /><RaceMmrPanel breakdown={unavailable} isLoading={false} confirmedIdentity={confirmed} /></>);
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByText(/A current-season race breakdown is unavailable for this main profile/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "View SC2Pulse profile" }).getAttribute("href")).toContain("id=236671");
  });

  test("an account correction with the same display name still invalidates the old rating", () => {
    const changed = { ...confirmed, target: { ...confirmed.target, pulseCharacterId: "999999" } };
    render(<HeadlineMmrChip breakdown={breakdown} fallbackMmr={5275} confirmedIdentity={changed} ladderIntel={{
      characterId: "236671", current: { rating: 6305, lastPlayed: "2026-05-12T15:45:33Z" },
    }} />);
    expect(screen.queryByRole("note")).toBeNull();
  });

  test("unconfirmed opponents keep their last-recorded fallback", () => {
    render(<HeadlineMmrChip breakdown={undefined} fallbackMmr={5190} />);
    expect(screen.getByRole("note", { name: "Last known MMR 5190" })).toBeTruthy();
  });

  test("an empty current season uses the matching main's latest recorded Pulse rating without a race claim", () => {
    const unavailable = { ...breakdown, resolved: false, races: [], topMmr: null, topRace: null };
    render(<HeadlineMmrChip breakdown={unavailable} fallbackMmr={5275} confirmedIdentity={confirmed} ladderIntel={{
      characterId: "236671", current: { rating: 6305, lastPlayed: "2026-05-12T15:45:33Z" },
    }} />);
    const rating = screen.getByRole("note", { name: "Latest recorded SC2Pulse MMR 6305 for Strange's main profile" });
    expect(rating.getAttribute("title")).toMatch(/Latest recorded SC2Pulse ladder rating · last played .*2026/);
    expect(screen.getByText("Latest MMR")).toBeTruthy();
    expect(screen.queryByLabelText(/Protoss|Random/)).toBeNull();
    expect(screen.queryByText("5,275")).toBeNull();
  });

  test("the latest-team fallback rejects old barcode intel and follows the current confirmed target", () => {
    render(<HeadlineMmrChip breakdown={undefined} fallbackMmr={5275} confirmedIdentity={confirmed} ladderIntel={{
      characterId: "8703807", current: { rating: 5275, lastPlayed: "2026-09-07T00:00:00Z" },
    }} />);
    expect(screen.queryByRole("note")).toBeNull();
  });

  test("a matching current-season race breakdown keeps priority over older latest-team intel", () => {
    render(<HeadlineMmrChip breakdown={breakdown} confirmedIdentity={confirmed} ladderIntel={{
      characterId: "236671", current: { rating: 6305, lastPlayed: "2026-05-12T15:45:33Z" },
    }} />);
    expect(screen.getByRole("note", { name: "Protoss MMR 6100 for Strange's main profile" })).toBeTruthy();
    expect(screen.queryByText("Latest MMR")).toBeNull();
  });

  test("the exact main's latest rating can appear before its race response arrives", () => {
    render(<HeadlineMmrChip breakdown={undefined} fallbackMmr={5275} confirmedIdentity={confirmed} ladderIntel={{
      characterId: "236671", current: { rating: 6305, lastPlayed: "2026-05-12T15:45:33Z" },
    }} />);
    expect(screen.getByRole("note", { name: "Latest recorded SC2Pulse MMR 6305 for Strange's main profile" })).toBeTruthy();
  });

  test("unlinking withholds cached main-profile races until the recorded account response arrives", () => {
    const { rerender } = render(<HeadlineMmrChip breakdown={breakdown} confirmedIdentity={confirmed} />);
    expect(screen.getByRole("note", { name: "Protoss MMR 6100 for Strange's main profile" })).toBeTruthy();
    rerender(<HeadlineMmrChip breakdown={breakdown} fallbackMmr={5275} />);
    expect(screen.queryByRole("note")).toBeNull();
    rerender(<HeadlineMmrChip breakdown={{
      ...breakdown, topRace: "Random", topMmr: 5275,
      ladderIdentity: { ...breakdown.ladderIdentity!, confirmed: false, pulseCharacterId: "8703807", toonHandle: "2-S2-2-240434" },
    }} fallbackMmr={5275} />);
    expect(screen.getByRole("note", { name: "Random MMR 5275" })).toBeTruthy();
  });
});
