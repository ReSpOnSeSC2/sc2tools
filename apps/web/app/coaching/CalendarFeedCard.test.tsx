import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { bookingIcs } from "@/lib/coaching/ics";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "student", isLoaded: true, isSignedIn: true, getToken: async () => "fixture-token" }) }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ slug, children }: { slug: string; children?: ReactNode }) => <a href={`/help/${slug}`}>{children ?? "Help"}</a> }));
import { CalendarFeedCard } from "./CalendarFeedCard";

let feed: { active: boolean; createdAt: string | null };
let secret = 0;
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
beforeEach(() => {
  feed = { active: false, createdAt: null }; secret = 0;
  vi.stubGlobal("fetch", vi.fn(async (_raw: string, init?: RequestInit) => {
    if (init?.method === "POST") { secret += 1; feed = { active: true, createdAt: "2026-11-10T09:00:00.000Z" }; return json({ ...feed, path: `/v1/calendar/${String(secret).repeat(43)}.ics` }); }
    if (init?.method === "DELETE") { feed = { active: false, createdAt: null }; return json(feed); }
    return json(feed);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows the private link once, regenerates it and turns it off", async () => {
  render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}><CalendarFeedCard /></SWRConfig>);
  await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Create calendar link" })));
  expect(await screen.findByText(/\/v1\/calendar\/1{43}\.ics$/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open in calendar app" }).getAttribute("href")).toMatch(/^webcal:\/\/.+\/v1\/calendar\/1{43}\.ics$/);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Regenerate link" })));
  expect(await screen.findByText(/\/v1\/calendar\/2{43}\.ics$/)).toBeTruthy();
  expect(screen.queryByText(/1{43}/)).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Turn off link" })));
  expect(await screen.findByText("No calendar link yet.")).toBeTruthy();
  expect(screen.queryByText(/\/v1\/calendar\//)).toBeNull();
});

it("a booking's calendar file is one confirmed UTC event with escaped text", () => {
  const ics = bookingIcs({ id: "b1", startAt: "2026-11-12T18:00:00.000Z", endAt: "2026-11-12T19:00:00.000Z" }, "Coaching session with Kim, the coach; level 2", new Date("2026-11-10T09:00:00.000Z"));
  expect(ics).toContain("UID:b1@sc2tools.com\r\nDTSTAMP:20261110T090000Z\r\nDTSTART:20261112T180000Z\r\nDTEND:20261112T190000Z\r\n");
  expect(ics).toContain("SUMMARY:Coaching session with Kim\\, the coach\\; level 2");
  expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
});
