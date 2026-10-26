import { useMemo, useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyRecoveryDialog } from "../CopyRecoveryDialog";
import { Modal } from "../Modal";

const text = "https://example.test/players/synthetic/replays?result=win";
function Host({ resource = "A" }: { resource?: string }) {
  const scope = useMemo(() => ({ resource }), [resource]);
  const [value, setValue] = useState<{ scope: object; text: string | null }>({ scope, text: null });
  const trigger = useRef<HTMLButtonElement>(null), input = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  return <><button ref={trigger} onClick={() => setValue({ scope, text })}>Open recovery</button>
    <CopyRecoveryDialog text={value.scope === scope ? value.text : null} inputRef={input} triggerRef={trigger}
      scopeKey={scope} onDismiss={() => setValue({ scope, text: null })} title="Recover replay link" label="Selected replay link" /></>;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("controlled copy recovery", () => {
  it("selects the exact read-only text and returns explicit Done, X and Escape to its action", async () => {
    const writeText = vi.fn(); vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<Host />);
    const trigger = screen.getByRole("button", { name: "Open recovery" });
    for (const how of ["Done", "Close", "Escape"] as const) {
      trigger.focus(); fireEvent.click(trigger);
      const dialog = screen.getByRole("dialog", { name: "Recover replay link" });
      const input = within(dialog).getByRole("textbox", { name: "Selected replay link" }) as HTMLInputElement;
      await waitFor(() => expect(document.activeElement).toBe(input));
      expect(input.readOnly).toBe(true); expect(input.value).toBe(text);
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, text.length]);
      if (how === "Escape") fireEvent.keyDown(input, { key: "Escape" });
      else fireEvent.click(within(dialog).getByRole("button", { name: how }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).toBe(trigger); expect(document.body.style.overflow).toBe("");
    }
    expect(writeText).not.toHaveBeenCalled();
  });

  it("closes before its parent while keeping the remaining focus trap and scroll lock", async () => {
    const close = vi.fn(); render(<Modal open title="Parent sharing settings" onClose={close}><Host /></Modal>);
    const trigger = screen.getByRole("button", { name: "Open recovery" }); trigger.focus(); fireEvent.click(trigger);
    const child = screen.getByRole("dialog", { name: "Recover replay link" });
    const done = within(child).getByRole("button", { name: "Done" }), x = within(child).getByRole("button", { name: "Close" });
    // jsdom does not perform the browser's native interior Tab traversal.
    // Exercise both managed boundaries here; the native fixture traverses all controls.
    done.focus(); fireEvent.keyDown(done, { key: "Tab" }); expect(document.activeElement).toBe(x);
    fireEvent.keyDown(x, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(done);
    fireEvent.keyDown(done, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    const parent = screen.getByRole("dialog", { name: "Parent sharing settings" });
    expect(document.body.style.overflow).toBe("hidden"); expect(close).not.toHaveBeenCalled();
    const parentX = within(parent).getByRole("button", { name: "Close" });
    fireEvent.keyDown(trigger, { key: "Tab" }); expect(document.activeElement).toBe(parentX);
    fireEvent.keyDown(parentX, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(trigger);
  });

  it("retires a controlled resource without copying or leaving a manual dialog mounted", async () => {
    const writeText = vi.fn(); vi.stubGlobal("navigator", { clipboard: { writeText } });
    const view = render(<Host />);
    const trigger = screen.getByRole("button", { name: "Open recovery" }); trigger.focus(); fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Recover replay link" })).toBeTruthy();
    view.rerender(<Host resource="B" />); view.rerender(<Host resource="A" />);
    expect(screen.queryByRole("dialog")).toBeNull(); expect(document.body.style.overflow).toBe("");
    expect(writeText).not.toHaveBeenCalled();
  });
});
