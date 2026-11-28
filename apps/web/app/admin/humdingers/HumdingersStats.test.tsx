import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HumdingersPlayer, HumdingersStatsResp } from "./HumdingersStats";
import { HumdingersStats } from "./HumdingersStats";

const api = vi.hoisted(() => ({ paths: [] as string[], error: null as null | { status: number; message: string }, data: null as unknown }));
vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string) => {
    api.paths.push(path);
    return { data: api.error ? undefined : api.data, error: api.error, mutate: vi.fn() };
  },
}));

const day = (date: string, loads: number, extra: Partial<HumdingersStatsResp["daily"][number]> = {}) =>
  ({ day: date, loads, players: loads ? 1 : 0, activeSeconds: 0, longPlays: 0, savers: 0, maxChapter: 0, ...extra });

const ann: HumdingersPlayer = {
  userId: "user/ann", displayName: "AnnPlays", battleTag: "Ann#1234", email: "ann@example.com",
  sessions: 2, activeSeconds: 4_500, lastAt: "2026-11-27T11:00:00.000Z", maxChapter: 3, save: { slots: 2, playtime: 9_000, chapter: 4, savedAt: "2026-11-27T10:30:00.000Z" },
  recent: [
    { startedAt: "2026-11-27T10:00:00.000Z", lastAt: "2026-11-27T11:00:00.000Z", activeSeconds: 3_600, maxChapter: 3, saved: true,
      session: "visit-ann-1", tape: { build: "19bbccd577ad", chunks: 12, bytes: 9_000, ticks: 14_700, final: true, summary: null } },
    { startedAt: "2026-11-26T09:00:00.000Z", lastAt: "2026-11-26T09:20:00.000Z", activeSeconds: 900, maxChapter: 2, saved: false },
  ],
};
const bob: HumdingersPlayer = {
  userId: "user-bob", displayName: null, battleTag: null, email: "bob@example.com",
  sessions: 0, activeSeconds: 0, lastAt: null, maxChapter: 0, save: { slots: 1, playtime: 20, chapter: 1, savedAt: "2026-11-25T08:00:00.000Z" }, recent: [],
};

beforeEach(() => {
  api.paths = [];
  api.error = null;
  api.data = {
    days: 30,
    totals: { loads: 5, playerDays: 3, activeSeconds: 11_100, longPlays: 2, savers: 1, maxChapter: 4 },
    daily: [day("2026-11-27", 3, { players: 2, activeSeconds: 7_500, longPlays: 2, savers: 1, maxChapter: 4 }), day("2026-11-26", 0), day("2026-11-25", 2, { activeSeconds: 3_600 })],
    players: [ann, bob],
    playersTruncated: false,
  } satisfies HumdingersStatsResp;
});
afterEach(cleanup);

it("shows the range totals and one row per day with plays", () => {
  render(<HumdingersStats />);
  expect(api.paths.at(-1)).toBe("/v1/admin/humdingers/stats?days=30");
  expect(screen.getByText("3 h 5 min")).toBeTruthy();
  expect(screen.getByText("1 h 2 min")).toBeTruthy();
  const rows = within(screen.getByRole("table", { name: "Humdingers plays by day" })).getAllByRole("row");
  expect(rows).toHaveLength(3);
  expect(rows[1].textContent).toContain("Nov 27");
  expect(rows[1].textContent).toContain("2 h 5 min");
  expect(rows[2].textContent).toContain("Nov 25");
  fireEvent.click(screen.getByRole("radio", { name: "7 days" }));
  expect(api.paths.at(-1)).toBe("/v1/admin/humdingers/stats?days=7");
});

it("names each player and opens their individual sessions", () => {
  render(<HumdingersStats />);
  expect(screen.getByRole("heading", { level: 2, name: "Players (2)" })).toBeTruthy();
  const players = screen.getByRole("table", { name: "Humdingers players" });
  const annRow = within(players).getByRole("rowheader", { name: /AnnPlays/ }).closest("tr")!;
  expect(within(annRow).getByRole("link", { name: "AnnPlays" }).getAttribute("href")).toBe("/admin/users/user%2Fann");
  expect(annRow.textContent).toContain("Ann#1234 · ann@example.com");
  expect(annRow.textContent).toContain("1 h 15 min");
  expect(annRow.textContent).toContain("2 h 30 min");
  // The furthest chapter is the larger of the sessions' and the saves'.
  expect(within(annRow).getAllByRole("cell")[3].textContent).toBe("4");
  const bobRow = within(players).getByRole("rowheader", { name: /bob@example.com/ }).closest("tr")!;
  expect(within(bobRow).getByRole("link", { name: "bob@example.com" }).getAttribute("href")).toBe("/admin/users/user-bob");
  expect(within(bobRow).getAllByRole("cell")[0].textContent).toBe("–");
  expect(within(bobRow).queryByRole("button")).toBeNull();
  expect(bobRow.textContent).toContain("under 1 min");

  expect(screen.queryByRole("table", { name: "Sessions for AnnPlays, newest first" })).toBeNull();
  const toggle = within(annRow).getByRole("button", { name: "Show 2 sessions for AnnPlays" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBeTruthy();
  const sessions = within(screen.getByRole("table", { name: "Sessions for AnnPlays, newest first" })).getAllByRole("row");
  expect(sessions).toHaveLength(3);
  expect(sessions[1].textContent).toContain("1 h 0 min");
  expect(sessions[1].textContent).toContain("Yes");
  expect(sessions[2].textContent).toContain("15 min");
  expect(sessions[2].textContent).toContain("No");
  // a session with a run tape can be watched (ADR 0113); one without shows a dash
  const watch = within(sessions[1]).getByRole("link", { name: /^Watch the session of .* for AnnPlays$/ });
  expect(watch.getAttribute("href")).toBe("/admin/humdingers/watch/user%2Fann/visit-ann-1");
  expect(watch.textContent).toBe("Watch 4:05");
  expect(within(sessions[2]).queryByRole("link")).toBeNull();
  fireEvent.click(within(annRow).getByRole("button", { name: "Hide 2 sessions for AnnPlays" }));
  expect(screen.queryByRole("table", { name: "Sessions for AnnPlays, newest first" })).toBeNull();
});

it("explains an empty player list and a truncated one", () => {
  api.data = { ...(api.data as HumdingersStatsResp), players: [] };
  const { unmount } = render(<HumdingersStats />);
  expect(screen.getByRole("heading", { level: 2, name: "Players (0)" })).toBeTruthy();
  expect(screen.getByText("No player sessions in this range yet.")).toBeTruthy();
  unmount();
  api.data = { ...(api.data as HumdingersStatsResp), players: [ann], playersTruncated: true };
  render(<HumdingersStats />);
  expect(screen.getByRole("heading", { level: 2, name: "Players (1+)" })).toBeTruthy();
  expect(screen.getByText(/Only the 200 most recent players are listed\./)).toBeTruthy();
});

it("says when nobody has played and keeps non-admins out", () => {
  api.data = { days: 30, totals: { loads: 0, playerDays: 0, activeSeconds: 0, longPlays: 0, savers: 0, maxChapter: 0 }, daily: [day("2026-11-27", 0)], players: [], playersTruncated: false };
  const { unmount } = render(<HumdingersStats />);
  expect(screen.getByText("No plays yet")).toBeTruthy();
  expect(screen.queryByRole("table")).toBeNull();
  unmount();
  api.error = { status: 403, message: "Forbidden" };
  render(<HumdingersStats />);
  expect(screen.queryByText("Humdingers")).toBeNull();
});
