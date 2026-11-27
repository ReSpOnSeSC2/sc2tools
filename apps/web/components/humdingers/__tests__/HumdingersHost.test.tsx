import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { HumdingersHost } from "../HumdingersHost";

const auth = vi.hoisted(() => ({ isLoaded: true, isSignedIn: true, getToken: async () => "token-1" }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));

const save = (when: number) => JSON.stringify({ fmt: "humdingers-save", v: 3, meta: { when, chapter: 3, playtime: 9 }, state: {} });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let fetchMock: Mock;

beforeEach(() => {
  window.localStorage.clear();
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/v1/me/humdingers/saves") && !init?.method) return json({ saves: [{ slot: "0", data: save(200), when: 200 }] });
    if (String(url).endsWith("/v1/me/humdingers/plays")) return new Response(null, { status: 204 });
    return json({ save: { slot: "1" } });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const requests = (method: string, pathEnd: string) => fetchMock.mock.calls
  .filter(([url, init]) => String(url).endsWith(pathEnd) && (init?.method ?? "GET") === method);

it("brings account saves in before the game starts, in a full-screen frame that allows fullscreen", async () => {
  window.localStorage.setItem("humdingers.save.0", save(100));
  render(<HumdingersHost />);
  expect(screen.getByRole("status").textContent).toContain("Loading your saves");
  const frame = await screen.findByTitle("Humdingers");
  expect(window.localStorage.getItem("humdingers.save.0")).toBe(save(200));
  expect(frame.getAttribute("src")).toBe("/play/humdingers.html");
  expect(frame.getAttribute("allow")).toContain("fullscreen");
  expect(frame.hasAttribute("allowfullscreen")).toBe(true);
});

it("uploads a save the game writes and counts the load", async () => {
  render(<HumdingersHost />);
  const frame = await screen.findByTitle("Humdingers");
  fireEvent.load(frame);
  await waitFor(() => expect(requests("POST", "/v1/me/humdingers/plays")).toHaveLength(1));
  expect(JSON.parse(String(requests("POST", "/v1/me/humdingers/plays")[0][1]?.body)))
    .toEqual({ session: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/), type: "load", chapter: 3, saved: true });
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key: "humdingers.save.1", newValue: save(300), storageArea: window.localStorage }));
    window.dispatchEvent(new StorageEvent("storage", { key: "humdingers.audio", newValue: "{}", storageArea: window.localStorage }));
  });
  await waitFor(() => expect(requests("PUT", "/v1/me/humdingers/saves/1")).toHaveLength(1), { timeout: 4_000 });
  expect(JSON.parse(String(requests("PUT", "/v1/me/humdingers/saves/1")[0][1]?.body))).toEqual({ data: save(300) });
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes("audio"))).toBe(false);
});
