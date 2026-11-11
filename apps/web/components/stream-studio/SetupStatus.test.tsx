import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import { StreamStudioCourse } from "./SetupStatus";

const { auth } = vi.hoisted(() => ({ auth: { isLoaded: true, isSignedIn: true, userId: "owner", getToken: async () => "owner-jwt" } }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
const fetchSpy = vi.fn();
const timestamp = () => new Date().toISOString();
const storage = "sc2tools:stream-studio:crash-course:v1";
let chatStatus = 200;
let hasSource = true;
function Fixture() { return <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}><StreamStudioCourse /></SWRConfig>; }
beforeEach(() => {
  auth.isLoaded = true; auth.isSignedIn = true; auth.userId = "owner"; chatStatus = 200; hasSource = true;
  localStorage.clear();
  fetchSpy.mockReset().mockImplementation(async (input: string) => {
    const path = new URL(input).pathname;
    if (path === "/v1/devices") return Response.json({ items: [{ lastSeenAt: timestamp() }] });
    if (path === "/v1/overlay-tokens") return Response.json({ items: [
      { token: "old-token", revokedAt: timestamp() }, { token: "private-token", enabledWidgets: ["session", "opponent"] },
    ] });
    if (path === "/v1/overlay-tokens/private-token/presence") return Response.json({ sampledAt: timestamp(), surfaces: hasSource ? { widget: { count: 1 }, dock: { count: 1 } } : {} });
    if (path === "/v1/me/preferences/multichat") return Response.json({ twitch: { enabled: true } }, { status: chatStatus });
    throw new Error(`Unexpected request to ${path}`);
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("renders no setup statuses and makes no requests when signed out or auth is still loading", async () => {
  auth.isLoaded = false;
  const view = render(<Fixture />);
  await act(async () => {});
  expect(screen.queryByRole("heading", { name: "Your setup" })).toBeNull();
  auth.isLoaded = true; auth.isSignedIn = false; view.rerender(<Fixture />);
  expect(screen.queryByRole("heading", { name: "Your setup" })).toBeNull();
  expect(screen.getByRole("navigation", { name: "Crash course lessons" })).toBeTruthy();
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("shows the same signed-out finish checklist without widget statuses", () => {
  auth.isSignedIn = false;
  localStorage.setItem(storage, JSON.stringify({ activeId: "pair-your-pc", completed: [
    "connect-the-dots", "pair-your-pc", "build-your-scene", "test-with-purpose", "make-it-yours",
  ] }));
  render(<Fixture />);
  const summary = screen.getByRole("region", { name: "Your first scene checklist" });
  expect(within(summary).getByText("Session record")).toBeTruthy();
  expect(within(summary).queryByText("Not enabled")).toBeNull();
  expect(within(summary).getByRole("link", { name: "Build vote" })).toBeTruthy();
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("retries one failed row without masking the other setup checks", async () => {
  chatStatus = 503;
  render(<Fixture />);
  const list = screen.getByRole("region", { name: "Your setup" });
  const button = await within(list).findByRole("button", { name: "Retry chat platform configured" });
  expect(within(list).getByText("Couldn’t check")).toBeTruthy();
  expect(within(list).queryByText("Connect a chat platform")).toBeNull();
  expect(await within(list).findByText(/Seen just now/)).toBeTruthy();
  chatStatus = 200;
  fireEvent.click(button);
  expect(await within(list).findByText("1 platform enabled")).toBeTruthy();
  expect(document.body.textContent).not.toContain("private-token");
});

it("adds live checks to manual progress and summarizes the starter widgets after the five core lessons", async () => {
  localStorage.setItem(storage, JSON.stringify({ activeId: "pair-your-pc", completed: ["connect-the-dots", "build-your-scene"] }));
  render(<Fixture />);
  expect(await screen.findByRole("heading", { name: "Your first scene checklist" })).toBeTruthy();
  const summary = screen.getByRole("region", { name: "Your first scene checklist" });
  expect(within(summary).getByLabelText("Completed lessons").children).toHaveLength(5);
  expect(within(summary).getAllByText("Enabled")).toHaveLength(2);
  expect(within(summary).getByText("Not enabled").parentElement?.textContent).toContain("Match result");
  expect(screen.getByRole("button", { name: /2\. Pair your gaming PC.*checked automatically/ })).toBeTruthy();
  expect(JSON.parse(localStorage.getItem(storage)!).completed).toEqual(["connect-the-dots", "build-your-scene"]);
});

it("halts polling while hidden and keeps accepted and manually completed lessons when presence changes", async () => {
  vi.useFakeTimers();
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => hidden ? "hidden" : "visible");
  localStorage.setItem(storage, JSON.stringify({ activeId: "test-with-purpose", completed: ["connect-the-dots"] }));
  render(<Fixture />);
  await act(async () => vi.advanceTimersByTimeAsync(50));
  expect(screen.getByRole("button", { name: /4\. Test, then play.*checked automatically/ })).toBeTruthy();
  expect(fetchSpy).toHaveBeenCalledTimes(4);
  hidden = true; act(() => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => vi.advanceTimersByTimeAsync(90_000));
  expect(fetchSpy).toHaveBeenCalledTimes(4);
  hasSource = false; hidden = false; act(() => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => vi.advanceTimersByTimeAsync(50));
  expect(fetchSpy).toHaveBeenCalledTimes(8);
  expect(screen.getByText("Add an OBS Browser Source")).toBeTruthy();
  expect(screen.getByRole("button", { name: /4\. Test, then play.*checked automatically/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /1\. Connect the dots.*Complete/ })).toBeTruthy();
});
