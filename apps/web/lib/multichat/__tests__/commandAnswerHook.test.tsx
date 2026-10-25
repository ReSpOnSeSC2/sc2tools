import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCommandAnswers, ANSWER_TTL_MS } from "../useCommandAnswers";
import type { ChatMessage } from "../types";
const args = { apiBase: "http://fixture.invalid", token: "A", enabled: true };
const message = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, text, user: `Viewer${id}`, platform: "kick", badges: [], atMs: Date.now(), ...extra });
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: "reply", text: "Exact recorded reply", command: "winrate" }) }))); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("delegates new/custom aliases and arguments, displays the server's canonical command", async () => {
  const view = renderHook(({ messages }) => useCommandAnswers(messages, args), { initialProps: { messages: [] as ChatMessage[] } });
  view.rerender({ messages: [message("1", "!myrate PvZ")] });
  await waitFor(() => expect(view.result.current?.text).toBe("Exact recorded reply"));
  expect(fetch).toHaveBeenCalledTimes(1); expect(vi.mocked(fetch).mock.calls[0][0]).toBe("http://fixture.invalid/v1/multichat/A/command");
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({ command: "myrate", argument: "PvZ", user: "Viewer1", platform: "kick" });
  expect(view.result.current?.command).toBe("winrate");
});
it("does not answer backlog, old, prediction messages or an unchanged message twice", async () => {
  const view = renderHook(({ messages }) => useCommandAnswers(messages, args), { initialProps: { messages: [] as ChatMessage[] } });
  view.rerender({ messages: [message("a", "!mmr", { backlog: true }), message("b", "!mmr", { atMs: Date.now() - 9000 }), message("c", "!win")] });
  expect(fetch).not.toHaveBeenCalled(); const live = message("d", "!record"); view.rerender({ messages: [live] });
  await waitFor(() => expect(view.result.current).not.toBeNull()); view.rerender({ messages: [live] }); expect(fetch).toHaveBeenCalledTimes(1);
});
it("retains viewer rank aliases and the selected loyalty race", async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ found: true, xp: 40, level: 2, xpToNext: 20, oracleScore: 10 }) } as Response);
  const view = renderHook(({ messages }) => useCommandAnswers(messages, { ...args, rankRace: "zerg" }), { initialProps: { messages: [] as ChatMessage[] } });
  view.rerender({ messages: [message("a", "!xp")] }); await waitFor(() => expect(view.result.current?.command).toBe("rank"));
  expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("/engagement/viewer?"); expect(view.result.current?.text).toContain("40 XP"); expect(view.result.current?.text).toContain("oracle pts");
});
it("bounds in-flight work, ignores older completions and hides disabled replies", async () => {
  const bodies: Array<(value: unknown) => void> = [];
  vi.mocked(fetch).mockImplementation(async () => ({ ok: true, status: 200, json: () => new Promise(resolve => bodies.push(resolve)) }) as Response);
  const view = renderHook(({ messages }) => useCommandAnswers(messages, args), { initialProps: { messages: [] as ChatMessage[] } });
  view.rerender({ messages: [message("1", "!record"), message("2", "!streak"), message("3", "!peak")] });
  await waitFor(() => expect(bodies).toHaveLength(2)); expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => bodies[1]({ status: "reply", text: "Newer answer", command: "streak" }));
  await act(async () => bodies[0]({ status: "reply", text: "Older answer", command: "record" })); expect(view.result.current?.text).toBe("Newer answer");
  vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: "disabled", text: null, command: "uptime" }) } as Response);
  view.rerender({ messages: [message("4", "!uptime")] }); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3)); expect(view.result.current?.text).toBe("Newer answer");
});
it("fences held bodies across A→B→A token changes and skips messages already present at the boundary", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: () => new Promise(resolve => { finish = resolve; }) } as Response);
  const view = renderHook(({ messages, token }) => useCommandAnswers(messages, { ...args, token }), { initialProps: { messages: [] as ChatMessage[], token: "A" } });
  const live = message("a", "!mmr"); view.rerender({ messages: [live], token: "A" }); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  view.rerender({ messages: [live], token: "B" }); view.rerender({ messages: [live], token: "A" });
  await act(async () => finish({ status: "reply", text: "Late private answer", command: "mmr" })); expect(view.result.current).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
});
it("expires answers and settles a held request deadline without blocking new commands", async () => {
  vi.useFakeTimers(); const view = renderHook(({ messages }) => useCommandAnswers(messages, args), { initialProps: { messages: [] as ChatMessage[] } });
  await act(async () => view.rerender({ messages: [message("a", "!record")] }));
  expect(view.result.current?.text).toBe("Exact recorded reply"); await act(async () => vi.advanceTimersByTime(ANSWER_TTL_MS)); expect(view.result.current).toBeNull();
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => {}));
  act(() => view.rerender({ messages: [message("b", "!streak")] })); await act(async () => vi.advanceTimersByTime(15_000));
  await act(async () => view.rerender({ messages: [message("c", "!streak")] })); expect(fetch).toHaveBeenCalledTimes(3); expect(view.result.current?.text).toBe("Exact recorded reply");
});
