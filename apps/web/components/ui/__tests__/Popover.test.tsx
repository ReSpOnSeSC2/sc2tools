import { StrictMode, useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Modal } from "../Modal";
import { Popover } from "../Popover";

afterEach(() => { cleanup(); vi.useRealTimers(); document.body.style.overflow = ""; });
function Standalone({ late = false }: { late?: boolean }) {
  const [open, setOpen] = useState(false); const anchor = useRef<HTMLButtonElement>(null);
  return <><button ref={anchor} onClick={() => setOpen(true)}>Options</button><button>Other action</button><p>Outside text</p>
    {/* eslint-disable-next-line jsx-a11y/no-autofocus -- Exercises controlled overlay entry focus, not a native DOM autofocus attribute. */}
    <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} label="Options panel" autoFocus={!late}><button>First option</button><button>Last option</button></Popover></>;
}
it("is nonmodal and lets Tab leave its last control", () => {
  render(<Standalone />); const trigger = screen.getByRole("button", { name: "Options" }); trigger.focus(); fireEvent.click(trigger);
  const panel = screen.getByRole("dialog", { name: "Options panel" });
  expect(panel.hasAttribute("aria-modal")).toBe(false); expect(document.body.style.overflow).toBe("");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "First option" }));
  const last = screen.getByRole("button", { name: "Last option" }); last.focus();
  expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(true);
  fireEvent.keyDown(last, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(trigger);
});
it("supports consumer-timed focus and never restores over an outside pointer action", () => {
  render(<Standalone late />); const trigger = screen.getByRole("button", { name: "Options" }); trigger.focus(); fireEvent.click(trigger);
  expect(document.activeElement).toBe(trigger);
  const other = screen.getByRole("button", { name: "Other action" }); other.focus();
  fireEvent.pointerDown(other); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(other);
});
function Nested({ externalPortal = false, portal, radios = false, busy = false }: { externalPortal?: boolean; portal?: Element; radios?: boolean; busy?: boolean }) {
  const [open, setOpen] = useState(false); const [popover, setPopover] = useState(false); const anchor = useRef<HTMLButtonElement>(null);
  return <><button onClick={() => setOpen(true)}>Open parent</button>{open ? <Modal open onClose={() => setOpen(false)} title="Parent" disableScrimClose={busy}>
    <button ref={anchor} onClick={() => setPopover(true)}>Open popover</button>
    {radios ? <fieldset><legend>Reason</legend><input type="radio" name="reason" aria-label="One" /><input type="radio" name="reason" aria-label="Two" defaultChecked /><input type="radio" name="reason" aria-label="Three" /></fieldset> : null}<button>Parent last</button>
    <Popover open={popover} onClose={() => setPopover(false)} anchorRef={anchor} label="Child options" portalContainer={portal ?? (externalPortal ? document.body : undefined)}><button>Popup first</button><button>Popup last</button></Popover>
  </Modal> : null}</>;
}
it.each([false, true])("preserves parent Tab containment and dismisses one layer at a time (external portal %s)", externalPortal => {
  render(<StrictMode><Nested externalPortal={externalPortal} /></StrictMode>);
  const opener = screen.getByRole("button", { name: "Open parent" }); opener.focus(); fireEvent.click(opener);
  const anchor = screen.getByRole("button", { name: "Open popover" }); anchor.focus(); fireEvent.click(anchor);
  const panel = screen.getByRole("dialog", { name: "Child options" }); const parent = screen.getByRole("dialog", { name: "Parent" });
  expect(parent.contains(panel)).toBe(!externalPortal);
  const last = screen.getByRole("button", { name: "Popup last" }); last.focus(); fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(within(parent).getByRole("button", { name: "Close" }));
  fireEvent.keyDown(document, { key: "Escape" }); expect(screen.queryByRole("dialog", { name: "Child options" })).toBeNull();
  expect(document.activeElement).toBe(anchor); expect(parent.isConnected).toBe(true); expect(document.body.style.overflow).toBe("hidden");
  fireEvent.keyDown(anchor, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(opener);
});
it("bridges an earlier external portal in both directions and preserves the selected radio Tab stop", () => {
  const host = document.createElement("div"), outside = document.createElement("button"); outside.textContent = "Outside gap";
  document.body.append(host, outside);
  render(<Nested portal={host} radios />); fireEvent.click(screen.getByRole("button", { name: "Open parent" }));
  const anchor = screen.getByRole("button", { name: "Open popover" }); anchor.focus(); fireEvent.click(anchor);
  const last = screen.getByRole("button", { name: "Parent last" }), first = screen.getByRole("button", { name: "Popup first" });
  last.focus(); fireEvent.keyDown(last, { key: "Tab" }); expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Two" }));
  fireEvent.keyDown(document.activeElement!, { key: "Tab" }); expect(document.activeElement).toBe(last);
  cleanup(); host.remove(); outside.remove();
});
it("restores a nonfocusable outside dismissal but keeps a native outside button focus action", () => {
  vi.useFakeTimers(); render(<Standalone />);
  const trigger = screen.getByRole("button", { name: "Options" }); trigger.focus(); fireEvent.click(trigger);
  fireEvent.pointerDown(screen.getByText("Outside text")); act(() => { vi.runAllTimers(); }); expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger); fireEvent.pointerDown(screen.getByRole("button", { name: "Other action" }));
  const other = screen.getByRole("button", { name: "Other action" }); other.focus();
  act(() => { vi.runAllTimers(); }); expect(document.activeElement).toBe(other);
});
it("returns to the popup trigger when a busy parent scrim blocks native pointer focus", () => {
  vi.useFakeTimers(); render(<Nested busy />); fireEvent.click(screen.getByRole("button", { name: "Open parent" }));
  const anchor = screen.getByRole("button", { name: "Open popover" }); anchor.focus(); fireEvent.click(anchor);
  const scrim = screen.getByRole("button", { name: "Close dialog" }); fireEvent.pointerDown(scrim); fireEvent.mouseDown(scrim); fireEvent.click(scrim);
  // Native clicks on nonfocusable dialog content can focus the dialog root.
  screen.getByRole("dialog", { name: "Parent" }).focus();
  act(() => { vi.runAllTimers(); }); expect(document.activeElement).toBe(anchor); expect(screen.getByRole("dialog", { name: "Parent" })).toBeTruthy();
});
it("returns focus outside when the parent and its portalled child unmount together", () => {
  const { unmount } = render(<Nested externalPortal />);
  const outside = document.createElement("button"); document.body.append(outside); outside.focus();
  fireEvent.click(screen.getByRole("button", { name: "Open parent" }));
  const anchor = screen.getByRole("button", { name: "Open popover" }); anchor.focus(); fireEvent.click(anchor);
  unmount(); expect(document.activeElement).toBe(outside); expect(document.body.style.overflow).toBe(""); outside.remove();
});
it("does not steal keyboard ownership from an unregistered custom dialog", () => {
  const close = vi.fn(); render(<Modal open onClose={close} title="Parent"><div role="dialog" aria-label="Custom"><button>Custom control</button></div></Modal>);
  const control = screen.getByRole("button", { name: "Custom control" }); control.focus();
  expect(fireEvent.keyDown(control, { key: "Tab", shiftKey: true })).toBe(true);
  fireEvent.keyDown(control, { key: "Escape" }); expect(close).not.toHaveBeenCalled();
});
