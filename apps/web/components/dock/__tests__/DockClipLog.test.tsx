import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DockClips } from "../DockClips";
import { useDockMarkUndo } from "../DockMarkUndo";
import { DEFAULT_STUDIO_STATE } from "@/lib/multichat/useStudioState";
import type { ClipMoment } from "@/lib/multichat/useEngagementState";
import type { DockPost } from "../dockActions";

const start = 1_700_000_000_000;
const moment = (offset: number, kind: ClipMoment["kind"], reason: string): ClipMoment => ({ atMs: start + offset, kind, reason, sampleLines: [] });
const json = (value: unknown) => new Response(JSON.stringify(value));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("loads the current token’s history, filters kinds, and merges manual flags with live updates", async () => {
  const marked = moment(50_000, "manual", "Review this fight");
  const requests = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/moment")) {
      expect(JSON.parse(String(init?.body))).toEqual({ note: marked.reason });
      return json({ moment: marked });
    }
    return url.searchParams.has("before")
      ? json({ moments: [moment(10_000, "chat-spike", "Older chat")], hasMore: false })
      : json({ moments: [moment(30_000, "game-event", "Battle"), moment(20_000, "chat-spike", "Chat spike")], hasMore: true, next: { atMs: start + 20_000, id: "012345678901234567890123" } });
  });
  vi.stubGlobal("fetch", requests);
  const props = { token: "dock-token", moments: [], streamStartMs: start, vodUrl: null, busy: false, onPost: vi.fn<DockPost>() };
  const view = render(<DockClips {...props} />);
  expect(await screen.findByText("Battle")).toBeTruthy();
  expect(requests.mock.calls[0][0]).toContain("/dock-token/moments?limit=100");
  fireEvent.click(screen.getByRole("button", { name: "Chat" }));
  expect(screen.queryByText("Battle")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show older" }));
  expect(await screen.findByText("Older chat")).toBeTruthy();
  expect(requests.mock.calls[1][0]).toContain(`before=${start + 20_000}&beforeId=012345678901234567890123`);
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Moment note (optional)" }), { target: { value: marked.reason } });
  fireEvent.click(screen.getByRole("button", { name: "Flag moment" }));
  expect(await screen.findByText(marked.reason)).toBeTruthy();
  view.rerender(<DockClips {...props} moments={[marked]} />);
  expect(screen.getAllByText(marked.reason)).toHaveLength(1);
});

it("disables chapters without a stream mark or enough separated moments", () => {
  const onPost = vi.fn<DockPost>();
  const moments = [moment(10_000, "game-event", "Only moment")];
  const view = render(<DockClips moments={moments} streamStartMs={null} vodUrl={null} busy={false} onPost={onPost} />);
  expect(screen.getByText("Mark stream start first")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Copy YouTube chapters" }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<DockClips moments={moments} streamStartMs={start} vodUrl={null} busy={false} onPost={onPost} />);
  expect(screen.getByText("YouTube needs at least 3 chapters")).toBeTruthy();
});

it("restores a mark once and stops offering an Undo after eight seconds or a newer change", async () => {
  vi.useFakeTimers();
  const post = vi.fn<DockPost>().mockResolvedValue({ ...DEFAULT_STUDIO_STATE, streamStartMs: start });
  const view = renderHook(({ current }: { current: number | null }) => useDockMarkUndo("dock-token", current, post), { initialProps: { current: null } });
  act(() => view.result.current.offer(start, null, "clips"));
  await act(async () => view.result.current.undo());
  expect(post).toHaveBeenCalledWith({ streamMarkUndo: { previous: start, expected: null } });
  expect(view.result.current.active).toBeNull();
  act(() => view.result.current.offer(start, null, "clips"));
  act(() => vi.advanceTimersByTime(8000));
  expect(view.result.current.active).toBeNull();
  act(() => view.result.current.offer(start, null, "game"));
  view.rerender({ current: start + 1000 });
  await act(async () => view.result.current.undo());
  expect(post).toHaveBeenCalledTimes(1);
});
