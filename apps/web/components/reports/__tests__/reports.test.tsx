import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import type { StreamPublication, StreamReport, WeeklyReport } from "@/lib/reports";
import { streamDiscordSummary } from "@/lib/reports";
import { weeklyReportShareCopy } from "@/lib/weeklyReportImage";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "ann", isLoaded: true, isSignedIn: true, getToken: async () => "fixture-token" }) }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ slug, children }: { slug: string; children?: ReactNode }) => <a href={`/help/${slug}`}>{children ?? "Help"}</a> }));
vi.mock("@/components/analyzer/settings/SettingsContext", () => ({ usePublishDirty: () => undefined }));
import { WeeklyReportView } from "../WeeklyReportView";
import { StreamReportView } from "../StreamReportView";
import { ReportPreferences } from "../ReportPreferences";

const week: WeeklyReport = {
  week: "2026-W46", previousWeek: "2026-W45", timeZone: "Europe/Berlin", start: "2026-11-08T23:00:00.000Z", end: "2026-11-15T23:00:00.000Z",
  totals: { games: 23, wins: 13, losses: 10, hours: 6.2, sessions: 4, previous: { games: 18, wins: 8, losses: 10, hours: 4.5, sessions: 3 } },
  matchups: [{ matchup: "PvZ", games: 11, wins: 7, losses: 4, previous: { games: 6, wins: 2, losses: 4 } }],
  mmr: [{ account: "Europe", race: "Protoss", games: 23, start: 4012, end: 4098, peak: 4120, delta: 86 }],
  maps: { best: { name: "Alcyone LE", games: 5, wins: 5, losses: 0 }, worst: null, minDecided: 3 },
  builds: { best: null, worst: null, minDecided: 3 },
  opponentStrategies: [{ name: "Roach push", games: 6, wins: 4, losses: 2 }],
  macro: { average: 71.5, games: 20, topLeak: { name: "Supply block", games: 9 }, previous: { average: 68, games: 15, topLeak: null }, minGames: 3 },
  truncated: false, navigation: { previous: "2026-W45", next: null, current: "2026-W46" },
};
const stream: StreamReport = {
  streamId: "abc123", startAt: "2026-11-10T18:00:00.000Z", endAt: "2026-11-10T22:00:00.000Z", endedBy: "manual", games: 14, wins: 9, losses: 5, hours: 3.1,
  matchups: [{ name: "PvZ", games: 8, wins: 6, losses: 2 }], maps: [{ name: "Alcyone LE", games: 4, wins: 3, losses: 1 }], builds: [{ name: "Stargate @everyone", games: 5, wins: 4, losses: 1 }],
  mmr: { account: "Europe", race: "Protoss", games: 14, start: 4000, end: 4042, peak: 4060, delta: 42, points: [4000, 4020, 4060, 4042] },
  bestWin: { gameId: "g1", map: "Alcyone LE", matchup: "PvZ", opponentMmr: 4300, durationSec: 700 }, randomizer: { games: 3, wins: 2, losses: 1 },
  crystalBall: { rounds: 10, picks: 40, correct: 26, viewers: 12, accuracy: 65 }, supporters: { events: 7, viewers: 5 },
  clips: [{ minute: 42, kind: "chat-spike", reason: "Chat spiked" }],
};
let prefs = { weekly: true, stream: true, timezone: null as string | null };
let fetcher: ReturnType<typeof vi.fn>;
let streamPublication: StreamPublication | undefined;
let streamVod: string | null;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const mount = (node: ReactNode) => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>{node}</SWRConfig>);
beforeEach(() => {
  prefs = { weekly: true, stream: true, timezone: null };
  streamPublication = undefined;
  streamVod = null;
  fetcher = vi.fn(async (raw: string, init?: RequestInit) => {
    const url = new URL(raw, "http://localhost");
    if (url.pathname.endsWith("/reports/weekly")) return json(week);
    if (url.pathname.endsWith("/reports/streams/abc123/sharing") && init?.method === "PATCH") {
      const { enabled } = JSON.parse(String(init.body));
      streamPublication = { eligible: true, enabled, href: enabled ? "/players/stream-player-0123456789/streams/AbCdEfGhIjKlMnOp" : null };
      return json(streamPublication);
    }
    if (url.pathname.endsWith("/reports/streams/abc123/vod") && init?.method === "PUT") {
      streamVod = JSON.parse(String(init.body)).url;
      return json({ vodUrl: streamVod });
    }
    if (url.pathname.endsWith("/reports/streams/abc123")) return json({ ...stream, publication: streamPublication, vodUrl: streamVod });
    if (url.pathname.endsWith("/preferences/reports")) { if (init?.method === "PUT") prefs = JSON.parse(String(init.body)); return json(prefs); }
    return json({});
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("weekly report shows facts beside the week before, with sample floors, week navigation and Trends", async () => {
  mount(<WeeklyReportView week="2026-W46" />);
  expect(await screen.findByText("13–10")).toBeTruthy();
  const query = new URL(fetcher.mock.calls[0][0], "http://localhost").searchParams;
  expect(query.get("week")).toBe("2026-W46");
  expect(query.has("tz")).toBe(false);
  expect(screen.getByRole("button", { name: "Share image" })).toBeTruthy();
  expect(screen.getByText("8–10 the week before")).toBeTruthy();
  expect(screen.getByText(/Week before: 2–4 in 6 games/)).toBeTruthy();
  expect(screen.getByText(/4012 → 4098 \(\+86\), peak 4120/)).toBeTruthy();
  expect(screen.getByText("Nothing with 3 or more decided games yet.")).toBeTruthy();
  expect(screen.getByText(/Roach push: 6 games, you went 4–2/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Previous week" }).getAttribute("href")).toBe("/app/reports/weekly/2026-W45");
  expect(screen.queryByRole("link", { name: "Next week" })).toBeNull();
  const trends = new URL(screen.getByRole("link", { name: "Open in Trends" }).getAttribute("href")!, "http://localhost");
  expect([trends.pathname, trends.searchParams.get("since"), trends.searchParams.get("until")]).toEqual(["/app/trends", "2026-11-08T23:00:00.000Z", "2026-11-15T22:59:59.999Z"]);
});

it("prepares weekly share copy from aggregates without account and opponent details", () => {
  const copy = weeklyReportShareCopy(week);
  expect(copy).toEqual({
    label: "Week 46, 2026",
    stats: [{ label: "Games", value: "23" }, { label: "Wins–losses", value: "13–10" }, { label: "Hours played", value: "6.2" }],
    previous: "Previous week: 18 games · 8–10 · 4.5 h",
    matchups: "PvZ 7–4",
  });
  expect(JSON.stringify(copy)).not.toMatch(/Europe|4098|Alcyone|Roach/);
});

it("stream report renders aggregates and copies a Discord summary without names or pings", async () => {
  mount(<StreamReportView id="abc123" />);
  expect(await screen.findByText("9–5")).toBeTruthy();
  expect(screen.getByText(/Crystal Ball: 10 rounds, 40 calls from 12 viewers, 65% right/)).toBeTruthy();
  expect(screen.getByRole("img", { name: "MMR from 4000 to 4042, low 4000, high 4060" })).toBeTruthy();
  const text = streamDiscordSummary(stream, "Nov 10, 2026");
  expect(text).toContain("14 games · 9–5 · 3.1 h");
  expect(text).toContain("Best win: PvZ on Alcyone LE vs 4300 MMR");
  expect(text).toContain("@\u200beveryone");
  expect(text).not.toContain("Chat spiked");
  expect(screen.getByRole("button", { name: "Copy Discord summary" })).toBeTruthy();
});

it("links clip offsets to a recording only after its owner saves the URL", async () => {
  mount(<StreamReportView id="abc123" />);
  const field = await screen.findByRole("textbox", { name: "Twitch or YouTube recording" });
  expect(screen.queryByRole("link", { name: "42:00 · Chat spiked" })).toBeNull();
  fireEvent.change(field, { target: { value: "https://www.twitch.tv/videos/42" } });
  fireEvent.click(screen.getByRole("button", { name: "Save recording link" }));
  const clip = await screen.findByRole("link", { name: "42:00 · Chat spiked" });
  expect(clip.getAttribute("href")).toBe("https://www.twitch.tv/videos/42?t=0h42m0s");
  fireEvent.click(screen.getByRole("button", { name: "Remove recording link" }));
  await waitFor(() => expect(screen.queryByRole("link", { name: "42:00 · Chat spiked" })).toBeNull());
});

it("only publishes a stream report after an explicit owner action and can revoke it", async () => {
  streamPublication = { eligible: true, enabled: false, href: null };
  mount(<StreamReportView id="abc123" />);
  const share = await screen.findByRole("button", { name: "Share report" });
  expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  fireEvent.click(share);
  expect(await screen.findByRole("button", { name: "Copy public report link" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Turn off sharing" }));
  expect(await screen.findByRole("button", { name: "Share report" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Copy public report link" })).toBeNull();
});

it("report settings save the switches and this device's time zone", async () => {
  mount(<ReportPreferences />);
  const weekly = await screen.findByRole("switch", { name: "Weekly report" });
  fireEvent.click(weekly);
  fireEvent.click(screen.getByRole("button", { name: /Use this device's time zone/ }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save report settings" })));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Report settings saved"));
  expect(prefs).toEqual({ weekly: false, stream: true, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
});
