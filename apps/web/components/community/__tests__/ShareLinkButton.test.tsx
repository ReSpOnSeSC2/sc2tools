import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal } from "@/components/ui/Modal";
import { ShareLinkButton } from "../ShareLinkButton";

const copy = vi.hoisted(() => ({ write: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("@/components/ui/Toast", () => ({ useToastOptional: () => ({ toast: { success: copy.success, info: copy.info } }) }));
const publicPath = "/community/builds/shared-a";
const href = (path = publicPath) => `${window.location.origin}${path}`;
function held() {
  let resolve!: () => void, reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  copy.write.mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText: copy.write } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetAllMocks(); window.history.replaceState({}, "", "/"); });

describe("canonical Community copy links", () => {
  it("copies only the supplied public path after an explicit action", async () => {
    window.history.replaceState({}, "", "/unrelated?not-for-sharing=synthetic");
    render(<ShareLinkButton path={publicPath} />);
    expect(copy.write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Share link" }));
    await screen.findByRole("button", { name: "Copied!" });
    expect(copy.write).toHaveBeenCalledTimes(1); expect(copy.write).toHaveBeenCalledWith(href());
    expect(copy.success).toHaveBeenCalledTimes(1); expect(copy.success).toHaveBeenCalledWith("Link copied");
  });

  it.each(["denied", "missing"])("shows a selected manual link when clipboard access is %s", async mode => {
    const close = vi.fn(), prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
    if (mode === "missing") vi.stubGlobal("navigator", {}); else copy.write.mockRejectedValue(new Error("Denied"));
    render(<Modal open onClose={close} title="Shared link host"><ShareLinkButton path={publicPath} /></Modal>);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" })));
    const trigger = screen.getByRole("button", { name: "Share link" }); fireEvent.click(trigger);
    const input = await screen.findByRole("textbox", { name: "Copy link manually" }) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.value).toBe(href()); expect(input.readOnly).toBe(true);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
    expect(input.closest('[role="dialog"]')).toBe(screen.getByRole("dialog", { name: "Shared link host" }));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Copy link manually" })).toBeNull();
    expect(document.activeElement).toBe(trigger); expect(close).not.toHaveBeenCalled();
    fireEvent.click(trigger); await screen.findByRole("textbox", { name: "Copy link manually" });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(document.activeElement).toBe(trigger);
    expect(copy.success).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled();
  });

  it("settles a held permission at five seconds and allows retry without a late old success", async () => {
    vi.useFakeTimers(); const pending = held(); copy.write.mockReturnValueOnce(pending.promise);
    render(<ShareLinkButton path={publicPath} />);
    const trigger = screen.getByRole("button", { name: "Share link" }); fireEvent.click(trigger);
    expect(trigger.matches(":disabled")).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
    expect(screen.queryByRole("textbox")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const input = screen.getByRole("textbox", { name: "Copy link manually" });
    expect(document.activeElement).toBe(input); expect(trigger.matches(":disabled")).toBe(false);
    expect(copy.success).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(trigger); });
    expect(screen.getByRole("button", { name: "Copied!" })).toBeTruthy();
    await act(async () => { pending.resolve(); });
    expect(copy.success).toHaveBeenCalledTimes(1); expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("retires a held result across path A to B to A without late focus, UI or toast", async () => {
    const pending = held(); copy.write.mockReturnValueOnce(pending.promise);
    const view = render(<ShareLinkButton path={publicPath} />);
    fireEvent.click(screen.getByRole("button", { name: "Share link" }));
    view.rerender(<ShareLinkButton path="/community/builds/shared-b" />);
    view.rerender(<ShareLinkButton path={publicPath} />);
    const current = screen.getByRole("button", { name: "Share link" }); current.focus();
    await act(async () => { pending.resolve(); });
    expect(document.activeElement).toBe(current); expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copied!" })).toBeNull();
    expect(copy.success).not.toHaveBeenCalled(); expect(copy.info).not.toHaveBeenCalled();
  });

  it("ignores a held rejection after unmount", async () => {
    const pending = held(); copy.write.mockReturnValueOnce(pending.promise);
    const view = render(<ShareLinkButton path={publicPath} />);
    fireEvent.click(screen.getByRole("button", { name: "Share link" })); view.unmount();
    await act(async () => { pending.reject(new Error("Late denial")); });
    expect(copy.success).not.toHaveBeenCalled(); expect(copy.info).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
