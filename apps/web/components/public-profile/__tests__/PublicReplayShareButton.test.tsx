import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Modal } from "@/components/ui/Modal";
import { PublicReplayShareButton } from "../PublicReplayShareButton";

const h = vi.hoisted(() => ({ write: vi.fn(), success: vi.fn(), info: vi.fn(), exec: vi.fn() }));
vi.mock("@/components/ui/Toast", () => ({
  useToastOptional: () => ({ toast: { success: h.success, info: h.info } }),
}));

const publicPath = "/players/reaver-0123456789/replays?matchup=PvZ&search=Blink&page=2&cursor=synthetic";
const otherPath = "/players/other-0123456789/replays?result=win";
const manualLabel = "Copy replay page link manually";
const originalExec = Object.getOwnPropertyDescriptor(document, "execCommand");
type Outcome = "resolve" | "reject" | "abort";
type Transition = "path" | "player" | "ABA";

function held() {
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = () => yes(); reject = no; });
  return { promise, resolve, reject };
}
async function settle(pending: ReturnType<typeof held>, outcome: Outcome) {
  await act(async () => {
    if (outcome === "resolve") pending.resolve();
    else pending.reject(outcome === "abort" ? { name: "AbortError" } : new Error("Late adapter failure"));
  });
}
const href = (value = publicPath) => `${window.location.origin}${value}`;
const content = (path = publicPath, playerName = "Reaver") => <PublicReplayShareButton path={path} playerName={playerName} />;
function clickShare(playerName = "Reaver") {
  const trigger = screen.getByRole("button", { name: `Share ${playerName}'s replay page` });
  trigger.focus(); fireEvent.click(trigger); return trigger;
}
async function selectedManual(value = href()) {
  const dialog = await screen.findByRole("dialog", { name: manualLabel });
  const input = within(dialog).getByRole("textbox", { name: manualLabel }) as HTMLInputElement;
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(input.readOnly).toBe(true); expect(input.value).toBe(value);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, value.length]);
  return { dialog, input };
}

beforeEach(() => {
  h.write.mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText: h.write } });
  Object.defineProperty(document, "execCommand", { configurable: true, value: h.exec });
});
afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetAllMocks();
  if (originalExec) Object.defineProperty(document, "execCommand", originalExec);
  else Reflect.deleteProperty(document, "execCommand");
  window.history.replaceState({}, "", "/");
});

describe("PublicReplayShareButton", () => {
  it("opens native sharing immediately with the supplied canonical path and query", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share, clipboard: { writeText: h.write } });
    window.history.replaceState({}, "", "/unrelated?private=synthetic");
    render(content());
    expect(share).not.toHaveBeenCalled(); expect(h.write).not.toHaveBeenCalled();
    clickShare();
    // No token, effect, clipboard call or awaited work may precede native share.
    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith({
      title: "Reaver's StarCraft II replays",
      text: "View and download Reaver's shared StarCraft II replays.", url: href(),
    });
    expect(await screen.findByText("Shared")).toBeTruthy();
    expect(h.success).toHaveBeenCalledWith("Replay page shared");
    expect(h.write).not.toHaveBeenCalled();
  });

  it("copies the exact canonical URL when native sharing is unavailable", async () => {
    render(content()); clickShare();
    expect(await screen.findByText("Link copied")).toBeTruthy();
    expect(h.write).toHaveBeenCalledTimes(1); expect(h.write).toHaveBeenCalledWith(href());
    expect(h.success).toHaveBeenCalledTimes(1); expect(h.success).toHaveBeenCalledWith("Replay page link copied");
  });

  it("treats native AbortError as quiet cancellation without clipboard or manual recovery", async () => {
    const share = vi.fn().mockRejectedValue({ name: "AbortError" });
    const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
    vi.stubGlobal("navigator", { share, clipboard: { writeText: h.write } });
    render(content()); clickShare();
    expect(await screen.findByText("Share replay page")).toBeTruthy();
    expect(h.write).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled();
    expect(h.exec).not.toHaveBeenCalled(); expect(h.success).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: manualLabel })).toBeNull();
  });

  it.each(["rejects", "throws"])("falls back to copy when native sharing %s with a real failure", async mode => {
    const share = mode === "throws"
      ? vi.fn(() => { throw new Error("share_failed"); })
      : vi.fn().mockRejectedValue(new Error("share_failed"));
    vi.stubGlobal("navigator", { share, clipboard: { writeText: h.write } });
    render(content()); clickShare();
    expect(await screen.findByText("Link copied")).toBeTruthy();
    expect(h.write).toHaveBeenCalledWith(href());
    expect(h.success).toHaveBeenCalledWith("Replay page link copied");
  });

  it("keeps a held native share pending without timing out into clipboard", async () => {
    vi.useFakeTimers(); const native = held(); const share = vi.fn(() => native.promise);
    vi.stubGlobal("navigator", { share, clipboard: { writeText: h.write } });
    render(content()); const trigger = clickShare();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(trigger.textContent).toContain("Opening share…"); expect(trigger.matches(":disabled")).toBe(true);
    expect(h.write).not.toHaveBeenCalled(); expect(h.success).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: manualLabel })).toBeNull();
    await settle(native, "abort");
    expect(trigger.textContent).toContain("Share replay page"); expect(trigger.matches(":disabled")).toBe(false);
    expect(h.write).not.toHaveBeenCalled();
  });

  it("cancels a previous Shared reset timer before starting another held native attempt", async () => {
    vi.useFakeTimers(); const native = held();
    const share = vi.fn().mockResolvedValueOnce(undefined).mockReturnValueOnce(native.promise);
    vi.stubGlobal("navigator", { share, clipboard: { writeText: h.write } });
    render(content());
    await act(async () => { clickShare(); });
    expect(screen.getByText("Shared")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    const trigger = clickShare();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(trigger.textContent).toContain("Opening share…"); expect(trigger.matches(":disabled")).toBe(true);
    expect(h.write).not.toHaveBeenCalled();
    await settle(native, "resolve");
    expect(trigger.textContent).toContain("Shared"); expect(h.success).toHaveBeenCalledTimes(2);
  });

  const retireNativeCases = (["path", "player", "ABA"] as const).flatMap(transition =>
    (["resolve", "reject", "abort"] as const).map(outcome => ({ transition, outcome })));
  it.each(retireNativeCases)("ignores old native $outcome after $transition while a current native share is pending", async ({ transition, outcome }) => {
    const oldNative = held(), currentNative = held();
    const share = vi.fn().mockReturnValueOnce(oldNative.promise).mockReturnValueOnce(currentNative.promise);
    vi.stubGlobal("navigator", { share, clipboard: { writeText: h.write } });
    const view = render(content()); clickShare();
    if (transition === "player") view.rerender(content(publicPath, "Current player"));
    else {
      view.rerender(content(otherPath));
      if (transition === "ABA") view.rerender(content());
    }
    const trigger = clickShare(transition === "player" ? "Current player" : "Reaver");
    expect(share).toHaveBeenCalledTimes(2);
    await settle(oldNative, outcome);
    expect(trigger.textContent).toContain("Opening share…"); expect(trigger.matches(":disabled")).toBe(true);
    expect(h.write).not.toHaveBeenCalled(); expect(h.success).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: manualLabel })).toBeNull();
    await settle(currentNative, "resolve");
    expect(trigger.textContent).toContain("Shared"); expect(h.success).toHaveBeenCalledTimes(1);
    expect(h.success).toHaveBeenCalledWith("Replay page shared");
  });

  it.each(["resolve", "reject", "abort"] as const)("ignores native %s after unmount", async outcome => {
    const native = held(); const share = vi.fn(() => native.promise);
    vi.stubGlobal("navigator", { share, clipboard: { writeText: h.write } });
    const view = render(content()); clickShare(); view.unmount();
    await settle(native, outcome);
    expect(h.write).not.toHaveBeenCalled(); expect(h.success).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: manualLabel })).toBeNull();
  });

  it.each(["denied", "missing", "throws"])("offers a selected manual URL when clipboard access is %s and retains the parent modal", async mode => {
    const close = vi.fn(), prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
    if (mode === "missing") vi.stubGlobal("navigator", {});
    else if (mode === "throws") h.write.mockImplementation(() => { throw new Error("Clipboard denied"); });
    else h.write.mockRejectedValue(new Error("Clipboard denied"));
    const view = render(<Modal open title="Replay share host" onClose={close}>{content()}</Modal>);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" })));
    const trigger = clickShare();
    const { dialog, input } = await selectedManual();
    const parent = screen.getByRole("dialog", { name: "Replay share host" });
    expect(parent.contains(dialog)).toBe(false); expect(input.closest('[role="dialog"]')).toBe(dialog);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: manualLabel })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger)); expect(close).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(trigger, { key: "Tab" }); expect(parent.contains(document.activeElement)).toBe(true);
    trigger.focus(); fireEvent.click(trigger);
    const reopened = await selectedManual();
    fireEvent.click(within(reopened.dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.click(trigger); const again = await selectedManual();
    fireEvent.click(within(again.dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(close).not.toHaveBeenCalled(); expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(trigger, { key: "Escape" }); expect(close).toHaveBeenCalledTimes(1);
    expect(h.success).not.toHaveBeenCalled(); expect(h.info).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled(); expect(h.exec).not.toHaveBeenCalled();
    expect(document.querySelector("textarea")).toBeNull();
    view.unmount(); expect(document.body.style.overflow).toBe("");
  });

  it("admits a held clipboard fallback after five seconds, returns to the trigger and allows retry without old delivery", async () => {
    vi.useFakeTimers(); const pending = held(); h.write.mockReturnValueOnce(pending.promise);
    render(<>{content()}<button>Another action</button></>);
    const trigger = clickShare(); screen.getByRole("button", { name: "Another action" }).focus();
    await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
    expect(screen.queryByRole("dialog", { name: manualLabel })).toBeNull(); expect(trigger.matches(":disabled")).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const dialog = screen.getByRole("dialog", { name: manualLabel });
    const input = within(dialog).getByRole("textbox", { name: manualLabel }) as HTMLInputElement;
    expect(document.activeElement).toBe(input); expect(input.value).toBe(href()); expect(input.readOnly).toBe(true);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
    expect(trigger.matches(":disabled")).toBe(false); expect(h.success).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(document.activeElement).toBe(trigger); expect(screen.queryByRole("dialog", { name: manualLabel })).toBeNull();
    await act(async () => { fireEvent.click(trigger); });
    expect(trigger.textContent).toContain("Link copied"); expect(h.write).toHaveBeenNthCalledWith(2, href());
    const outside = screen.getByRole("button", { name: "Another action" }); outside.focus();
    await settle(pending, "resolve");
    expect(document.activeElement).toBe(outside); expect(trigger.textContent).toContain("Link copied");
    expect(h.success).toHaveBeenCalledTimes(1); expect(h.info).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: manualLabel })).toBeNull();
  });

  const retireCopyCases: { transition: Transition; outcome: Outcome }[] = (["path", "player", "ABA"] as const).flatMap(transition =>
    (["resolve", "reject"] as const).map(outcome => ({ transition, outcome })));
  it.each(retireCopyCases)("ignores old clipboard $outcome after $transition and copies the current resource on retry", async ({ transition, outcome }) => {
    const pending = held(); h.write.mockReturnValueOnce(pending.promise);
    const view = render(content()); clickShare();
    if (transition === "player") view.rerender(content(publicPath, "Current player"));
    else {
      view.rerender(content(otherPath));
      if (transition === "ABA") view.rerender(content());
    }
    const currentName = transition === "player" ? "Current player" : "Reaver";
    const trigger = screen.getByRole("button", { name: `Share ${currentName}'s replay page` }); trigger.focus();
    await settle(pending, outcome);
    expect(document.activeElement).toBe(trigger); expect(trigger.textContent).toContain("Share replay page");
    expect(h.success).not.toHaveBeenCalled(); expect(screen.queryByRole("dialog", { name: manualLabel })).toBeNull();
    clickShare(currentName);
    expect(await screen.findByText("Link copied")).toBeTruthy();
    expect(h.write).toHaveBeenLastCalledWith(href(transition === "path" ? otherPath : publicPath));
    expect(h.success).toHaveBeenCalledTimes(1);
  });

  it.each(["resolve", "reject"] as const)("ignores held clipboard %s after unmount", async outcome => {
    const pending = held(); h.write.mockReturnValueOnce(pending.promise);
    const view = render(content()); clickShare(); view.unmount();
    await settle(pending, outcome);
    expect(h.success).not.toHaveBeenCalled(); expect(h.info).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: manualLabel })).toBeNull(); expect(document.body.style.overflow).toBe("");
  });
});
