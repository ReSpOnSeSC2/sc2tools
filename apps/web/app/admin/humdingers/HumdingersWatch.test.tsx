import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import type { ReplayStatus, TapeResp } from "./HumdingersWatch";
import { HumdingersWatch } from "./HumdingersWatch";

const api = vi.hoisted(() => ({ paths: [] as string[], error: null as null | { status: number; message: string }, data: null as unknown }));
vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string) => {
    api.paths.push(path);
    return { data: api.error ? undefined : api.data, error: api.error, mutate: vi.fn() };
  },
}));

const chunk = (seq: number, from: number, to: number, ev: unknown[]) =>
  ({ v: 1, seq, build: "19bbccd577ad", seed: 9, admin: false, from, to, inp: [10, 1, 4], ev });
const stored = (c: ReturnType<typeof chunk>) => ({ seq: c.seq, enc: "json", data: JSON.stringify(c), from: c.from, to: c.to });
const tape = (build = "19bbccd577ad"): TapeResp => ({
  tape: {
    userId: "user/ann", session: "visit-ann-1", build, ticks: 9_000, bytes: 900, final: true,
    summary: { ticks: 9_000, fights: 2, won: 1, lost: 1, hints: 1, goal: "Go home." },
    startedAt: "2026-11-28T10:00:00.000Z", lastAt: "2026-11-28T10:03:00.000Z",
    chunks: [
      stored(chunk(1, 1_800, 9_000, [[3_000, "end", "win", 1], [4_000, "scene", "gameover"], [5_000, "goal", "Go home."]])),
      stored(chunk(0, 0, 1_800, [[60, "new"], [600, "fight", "Lawn Hydra", 1]])),
    ],
  },
});

let status: ReplayStatus;
let control: Mock;
let fetchMock: Mock;
const replayStatus = (extra: Partial<ReplayStatus> = {}): ReplayStatus =>
  ({ tick: 1_200, end: 9_000, playing: false, speed: 2, seeking: false, target: -1, ended: false, drift: -1, gaps: [], held: ["ok"], scene: "title", build: "19bbccd577ad", ...extra });

function startGame(frame: HTMLElement, build = "19bbccd577ad") {
  const view = (frame as HTMLIFrameElement).contentWindow as unknown as Record<string, unknown>;
  view.G = { tape: { status: () => status, control } };
  view.HUM_BUILD = { build };
  fireEvent.load(frame);
}

beforeEach(() => {
  api.paths = [];
  api.error = null;
  api.data = tape();
  status = replayStatus();
  control = vi.fn(() => true);
  fetchMock = vi.fn(async (url: string) => new Response(null, { status: String(url).startsWith("/play/builds/19bbccd577ad") ? 200 : 404 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("hands the tape to the game on the build it was recorded on and drives it", async () => {
  render(<HumdingersWatch userId="user/ann" session="visit-ann-1" />);
  expect(api.paths.at(-1)).toBe("/v1/admin/humdingers/tapes/user%2Fann/visit-ann-1");
  const frame = await screen.findByTitle("Humdingers replay");
  expect(frame.getAttribute("src")).toBe("/play/builds/19bbccd577ad.html");
  expect(window.HUMDINGERS_HOST && "replay" in window.HUMDINGERS_HOST ? window.HUMDINGERS_HOST.replay.chunks.map((c) => c.seq) : null).toEqual([0, 1]);
  startGame(frame);
  expect(control).toHaveBeenCalledWith({ speed: 2, sound: false });
  const play = await screen.findByRole("button", { name: "Play" });
  await waitFor(() => expect((play as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(play);
  expect(control).toHaveBeenCalledWith({ play: true });
  fireEvent.click(screen.getByRole("button", { name: "8x" }));
  expect(control).toHaveBeenCalledWith({ speed: 8 });
  // the summary, the timeline list and the buttons held
  expect(screen.getByText("2 (won 1, lost 1)")).toBeTruthy();
  expect(screen.getAllByText("Won the boss fight").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Game over").length).toBeGreaterThan(0);
  expect(screen.getByText("No input for 1:59")).toBeTruthy();   // the last press at 1810, the tape ends at 9000
  expect(screen.getByText("held:")).toBeTruthy();
});

it("seeks forward in place and starts the tape again to go back", async () => {
  render(<HumdingersWatch userId="user/ann" session="visit-ann-1" />);
  const frame = await screen.findByTitle("Humdingers replay");
  startGame(frame);
  await screen.findByText("0:20 / 2:30");
  fireEvent.click(screen.getAllByRole("button", { name: /Won the boss fight/ })[0]);
  expect(control).toHaveBeenCalledWith({ seek: 3_000 });
  control.mockClear();
  fireEvent.click(screen.getAllByRole("button", { name: /Started a new game/ })[0]);
  const again = await screen.findByTitle("Humdingers replay");
  await waitFor(() => expect(screen.getByTitle("Humdingers replay")).not.toBe(frame));
  startGame(screen.getByTitle("Humdingers replay"));
  expect(control).toHaveBeenCalledWith({ seek: 60 });
  expect(again).toBeTruthy();
});

it("says when the build is gone and when the replay stops matching", async () => {
  api.data = tape("0123456789ab");
  status = replayStatus({ drift: 4_200 });
  render(<HumdingersWatch userId="user/ann" session="visit-ann-1" />);
  const frame = await screen.findByTitle("Humdingers replay");
  expect(frame.getAttribute("src")).toBe("/play/humdingers.html");
  startGame(frame, "19bbccd577ad");
  expect(await screen.findByText(/which the site no longer keeps/)).toBeTruthy();
  expect(await screen.findByText(/From 1:10 the replay no longer matches/)).toBeTruthy();
});

it("explains a missing tape and a tape the game refused", async () => {
  api.error = { status: 404, message: "not_found" };
  const { unmount } = render(<HumdingersWatch userId="user/ann" session="visit-ann-1" />);
  expect(screen.getByText("This visit has no tape. Tapes are kept for 90 days.")).toBeTruthy();
  unmount();
  api.error = null;
  render(<HumdingersWatch userId="user/ann" session="visit-ann-1" />);
  const frame = await screen.findByTitle("Humdingers replay");
  const view = (frame as HTMLIFrameElement).contentWindow as unknown as Record<string, unknown>;
  view.G = { tape: { status: () => null, control, error: "chunk 1 has a bad input entry" } };
  act(() => { fireEvent.load(frame); });
  expect(await screen.findByText("The game refused this tape: chunk 1 has a bad input entry.")).toBeTruthy();
});

it("seeks with the position bar once it is let go", async () => {
  render(<HumdingersWatch userId="user/ann" session="visit-ann-1" />);
  startGame(await screen.findByTitle("Humdingers replay"));
  await screen.findByText("0:20 / 2:30");
  const bar = screen.getByRole("slider", { name: "Position in the visit" });
  fireEvent.change(bar, { target: { value: "6000" } });
  fireEvent.change(bar, { target: { value: "7200" } });
  expect(control).not.toHaveBeenCalledWith({ seek: 6_000 });
  fireEvent.pointerUp(bar);
  expect(control).toHaveBeenCalledWith({ seek: 7_200 });
  expect(control).not.toHaveBeenCalledWith({ seek: 6_000 });
});
