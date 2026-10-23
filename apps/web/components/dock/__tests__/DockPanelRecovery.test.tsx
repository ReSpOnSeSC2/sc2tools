import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ButtonHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STUDIO_STATE } from "@/lib/multichat/useStudioState";
import type { DockPost } from "../dockActions";
import { DockPoll } from "../DockPoll";
import { DockGoals } from "../DockGoals";
import { DockClips } from "../DockClips";
import { DockScenes, DockTimer } from "../DockScenes";
import { BrollLibraryEditor } from "../BrollLibraryEditor";
import { useDockPanelActions } from "../useDockPanelActions";

vi.mock("../DockClient", () => ({ DockButton: ({ danger: _danger, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) => <button {...props} /> }));
vi.mock("@/components/overlay/widgets/StreamSceneWidget", () => ({ formatCountdown: () => "4:59" }));

afterEach(() => { cleanup(); vi.useRealTimers(); });
const change = (label: string, value: string) => fireEvent.change(screen.getByPlaceholderText(label), { target: { value } });
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };
const failingOnce = () => vi.fn<DockPost>().mockResolvedValueOnce(null).mockResolvedValue(DEFAULT_STUDIO_STATE);

describe("Dock panel snapshot and save recovery", () => {
  it("shows a delayed loading state and refuses function-level writes before readiness", async () => {
    vi.useFakeTimers();
    const onPost = vi.fn<DockPost>();
    render(<DockPoll poll={null} messages={[]} busy={false} studioReady={false} onPost={onPost} />);
    expect(screen.getByRole("status").textContent).toContain("Loading your saved controls");
    act(() => vi.advanceTimersByTime(15_000));
    expect(screen.getByRole("status").textContent).toContain("Still loading your saved controls — retrying");
    expect(screen.queryByPlaceholderText("Poll question")).toBeNull();
    const { result } = renderHook(() => useDockPanelActions(false, false, onPost, { save: () => ({ patch: { goals: [] }, message: "Saved" }) }));
    expect(await result.current.run("save")).toBeNull();
    expect(onPost).not.toHaveBeenCalled();
  });

  it("keeps poll input on failure and Retry reads the newer question before clearing on success", async () => {
    vi.useFakeTimers();
    const onPost = failingOnce();
    render(<DockPoll poll={null} messages={[]} busy={false} onPost={onPost} />);
    change("Poll question", "Old question"); change("Option 1", "One"); change("Option 2", "Two");
    await click("Start poll");
    expect((screen.getByPlaceholderText("Poll question") as HTMLInputElement).value).toBe("Old question");
    change("Poll question", "New question");
    await act(async () => { await onPost.mock.calls[0][1]!(); });
    expect(onPost).toHaveBeenLastCalledWith({ poll: { question: "New question", options: ["One", "Two"], status: "open" } }, expect.any(Function));
    expect((screen.getByPlaceholderText("Poll question") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("status").textContent).toBe("Poll started");
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps dirty goals through a failed save and a later snapshot, then retries the current list", async () => {
    const onPost = failingOnce();
    const goals = [{ label: "Followers", current: 2, target: 10 }];
    const { rerender } = render(<DockGoals goals={goals} busy={false} onPost={onPost} />);
    change("Goal label", "Draft"); await click("Save goals");
    rerender(<DockGoals goals={[{ ...goals[0], label: "Older server state" }]} busy={false} onPost={onPost} />);
    expect((screen.getByPlaceholderText("Goal label") as HTMLInputElement).value).toBe("Draft");
    change("Goal label", "Current draft");
    await act(async () => { await onPost.mock.calls[0][1]!(); });
    expect(onPost).toHaveBeenLastCalledWith({ goals: [{ ...goals[0], label: "Current draft" }] }, expect.any(Function));
    expect(screen.queryByText("Unsaved edits")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Goals saved");
  });

  it("keeps a failed VOD URL and clears only after an authoritative response", async () => {
    const onPost = failingOnce();
    render(<DockClips moments={[]} streamStartMs={null} vodUrl={null} busy={false} onPost={onPost} />);
    const field = screen.getByPlaceholderText(/Paste VOD URL/) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "https://youtu.be/abcDEF_1234" } }); await click("Save");
    expect(field.value).toBe("https://youtu.be/abcDEF_1234");
    await act(async () => { await onPost.mock.calls[0][1]!(); });
    expect(field.value).toBe(""); expect(screen.getByRole("status").textContent).toBe("VOD link saved");
  });

  it("keeps scene message and countdown on failure and retries newer values", async () => {
    const onPost = failingOnce();
    render(<DockScenes scene={null} broll={DEFAULT_STUDIO_STATE.broll} busy={false} onPost={onPost} />);
    change("Optional message — e.g. grabbing water, back in 5", "Water break"); await click("⏸ BRB");
    change("Optional message — e.g. grabbing water, back in 5", "Back shortly");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Countdown minutes" }), { target: { value: "10" } });
    const before = Date.now(); await act(async () => { await onPost.mock.calls[0][1]!(); });
    expect(onPost.mock.calls[1][0]).toMatchObject({ scene: { mode: "brb", message: "Back shortly" } });
    expect((onPost.mock.calls[1][0].scene as { countdownEndsAt: number }).countdownEndsAt).toBeGreaterThanOrEqual(before + 600_000);
    expect(screen.getByRole("status").textContent).toBe("Scene set to BRB");
  });

  it("keeps timer input on failure", async () => {
    const onPost = failingOnce();
    render(<DockTimer timer={null} busy={false} onPost={onPost} />);
    change("Optional label — e.g. next game in…", "Next match"); await click("⏱ Start timer");
    expect((screen.getByPlaceholderText("Optional label — e.g. next game in…") as HTMLInputElement).value).toBe("Next match");
    await act(async () => { await onPost.mock.calls[0][1]!(); });
    expect(screen.getByRole("status").textContent).toBe("Timer started");
  });

  it("preserves highlight cutting fields when saving the full library fails", async () => {
    const onPost = failingOnce();
    render(<BrollLibraryEditor broll={DEFAULT_STUDIO_STATE.broll} busy={false} onPost={onPost} />);
    fireEvent.click(screen.getByText("Manage highlight library"));
    fireEvent.change(screen.getByLabelText("YouTube URL or video ID"), { target: { value: "abcDEF_1234" } });
    fireEvent.change(screen.getByLabelText("B-roll clip title"), { target: { value: "My highlight" } });
    fireEvent.change(screen.getByLabelText("B-roll end time"), { target: { value: "1:30" } }); await click("+ Add highlight");
    expect((screen.getByLabelText("B-roll clip title") as HTMLInputElement).value).toBe("My highlight");
    await act(async () => { await onPost.mock.calls[0][1]!(); });
    expect((screen.getByLabelText("B-roll clip title") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("status").textContent).toBe("Highlight saved");
  });
});
