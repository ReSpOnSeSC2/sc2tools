import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_STUDIO_STATE } from "@/lib/multichat/useStudioState";
import { DockPoll } from "../DockPoll";
import { DockPollCard } from "../DockPollCard";
import type { DockPost } from "../dockActions";

afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };

it("fills presets, stores a bounded form per token, and only starts after an explicit click", async () => {
  const onPost = vi.fn<DockPost>().mockResolvedValue(DEFAULT_STUDIO_STATE);
  const props = { poll: null, messages: [], busy: false, onPost };
  const view = render(<DockPoll {...props} token="first" />);
  await click("Win or lose this game?");
  expect((screen.getByRole("textbox", { name: "Poll question" }) as HTMLInputElement).value).toBe("Win or lose this game?");
  expect(onPost).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("combobox", { name: "Poll duration" }), { target: { value: "30" } });
  await click("Start poll");
  expect(onPost).toHaveBeenCalledWith({ poll: { question: "Win or lose this game?", options: ["Win", "Lose"], status: "open", durationSec: 30 } }, expect.any(Function));
  view.rerender(<DockPoll {...props} token="second" />);
  expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
  view.rerender(<DockPoll {...props} token="first" />);
  await click("Run again");
  expect((screen.getByRole("combobox", { name: "Poll duration" }) as HTMLSelectElement).value).toBe("30");
  expect(onPost).toHaveBeenCalledTimes(1);
});

it("closes a timed poll once when its server deadline arrives", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(30_000);
  const onPost = vi.fn<DockPost>().mockResolvedValue(DEFAULT_STUDIO_STATE);
  const poll = { question: "Finish now?", options: ["Yes", "No"], status: "open" as const, startedAtMs: 1000, durationSec: 30 as const, endsAtMs: 31_000 };
  render(<DockPoll poll={poll} messages={[]} busy={false} onPost={onPost} />);
  expect(screen.getByText("0:01 left")).toBeTruthy();
  await act(async () => vi.advanceTimersByTime(1000));
  expect(onPost).toHaveBeenCalledWith({ poll: { ...poll, status: "closed" } }, expect.any(Function));
  await act(async () => vi.advanceTimersByTime(5000));
  expect(onPost).toHaveBeenCalledTimes(1);
});

it("opens Build vote from its preset without starting a poll", async () => {
  const onPost = vi.fn<DockPost>().mockResolvedValue(DEFAULT_STUDIO_STATE);
  render(<DockPollCard token="token" poll={null} messages={[]} busy={false} studioReady onPost={onPost} />);
  await click("Which build next?");
  expect(screen.getByRole("button", { name: "Build vote" }).getAttribute("aria-pressed")).toBe("true");
  expect(onPost).not.toHaveBeenCalled();
});
