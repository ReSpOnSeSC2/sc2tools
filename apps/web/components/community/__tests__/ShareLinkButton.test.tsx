import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal } from "@/components/ui/Modal";
import { ShareLinkButton } from "../ShareLinkButton";

const copy = vi.hoisted(() => ({ write: vi.fn(), success: vi.fn(), info: vi.fn(), manualClose: undefined as (() => void) | undefined }));
vi.mock("@/components/ui/Toast", () => ({ useToastOptional: () => ({ toast: { success: copy.success, info: copy.info } }) }));
vi.mock("@/components/ui/Modal", async importOriginal => {
  const original = await importOriginal<typeof import("@/components/ui/Modal")>();
  return { ...original, Modal: function ObservedModal(props: ComponentProps<typeof original.Modal>) {
    if (props.open && props.title === "Copy link manually") copy.manualClose = props.onClose;
    return <original.Modal {...props} />;
  } };
});
const publicPath = "/community/builds/shared-a";
const href = (path = publicPath) => `${window.location.origin}${path}`;
function held() {
  let resolve!: () => void, reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  copy.write.mockResolvedValue(undefined);
  copy.manualClose = undefined;
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
    const trigger = screen.getByRole("button", { name: "Share link" }); trigger.focus(); fireEvent.click(trigger);
    const manual = await screen.findByRole("dialog", { name: "Copy link manually" });
    const input = within(manual).getByRole("textbox", { name: "Copy link manually" }) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.value).toBe(href()); expect(input.readOnly).toBe(true);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
    expect(input.closest('[role="dialog"]')).toBe(manual);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Copy link manually" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger)); expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Shared link host" })).toBeTruthy();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(trigger, { key: "Tab" });
    expect(screen.getByRole("dialog", { name: "Shared link host" }).contains(document.activeElement)).toBe(true);
    trigger.focus(); fireEvent.click(trigger); await screen.findByRole("dialog", { name: "Copy link manually" });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    const reopened = await screen.findByRole("dialog", { name: "Copy link manually" });
    fireEvent.click(within(reopened).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(copy.success).not.toHaveBeenCalled(); expect(copy.info).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled();
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
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Copy link manually" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
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

  it("returns to the current copy trigger after focus moved during held permission", async () => {
    vi.useFakeTimers(); const pending = held(); copy.write.mockReturnValueOnce(pending.promise);
    render(<><ShareLinkButton path={publicPath} /><button>Another action</button></>);
    const trigger = screen.getByRole("button", { name: "Share link" }); fireEvent.click(trigger);
    screen.getByRole("button", { name: "Another action" }).focus();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Copy link manually" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Done" })); });
    expect(document.activeElement).toBe(trigger);
  });

  it("does not restore an old path's dismiss callback after A to B to A", async () => {
    copy.write.mockRejectedValue(new Error("Denied"));
    const content = (path: string) => <><ShareLinkButton path={path} /><button>Another action</button></>;
    const view = render(content(publicPath));
    const trigger = screen.getByRole("button", { name: "Share link" }); trigger.focus(); fireEvent.click(trigger);
    await screen.findByRole("dialog", { name: "Copy link manually" });
    const staleClose = copy.manualClose!;
    view.rerender(content("/community/builds/shared-b"));
    view.rerender(content(publicPath));
    const outside = screen.getByRole("button", { name: "Another action" }); outside.focus();
    await act(async () => { staleClose(); });
    expect(document.activeElement).toBe(outside);
    expect(screen.queryByRole("dialog", { name: "Copy link manually" })).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("yields explicit return focus to a replacement modal owner", async () => {
    copy.write.mockRejectedValue(new Error("Denied"));
    const content = (open: boolean) => <><Modal open={open} title="Replacement owner" onClose={() => {}}><button>Replacement action</button></Modal><ShareLinkButton path={publicPath} /></>;
    const view = render(content(false));
    const trigger = screen.getByRole("button", { name: "Share link" }); trigger.focus(); fireEvent.click(trigger);
    const manual = await screen.findByRole("dialog", { name: "Copy link manually" });
    await act(async () => {
      fireEvent.click(within(manual).getByRole("button", { name: "Done" }));
      view.rerender(content(true));
    });
    const replacement = screen.getByRole("dialog", { name: "Replacement owner" });
    expect(replacement.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(trigger); expect(document.body.style.overflow).toBe("hidden");
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
