import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useFocusTrap } from "./useFocusTrap";

function Example() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap({ open, containerRef: ref, onClose: () => setOpen(false) });
  return <><button onClick={() => setOpen(true)}>Open editor</button>{open ? <div role="dialog" tabIndex={-1} ref={ref}><div style={{ display: "none" }}><button>Hidden</button></div><fieldset disabled><button>Disabled</button></fieldset><button>First</button><button>Last</button></div> : null}</>;
}
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("focuses a visible control, wraps both ways and returns focus after Escape", async () => {
  vi.useFakeTimers(); render(<Example />);
  const trigger = screen.getByRole("button", { name: "Open editor" }); trigger.focus(); fireEvent.click(trigger);
  await act(async () => { vi.runAllTimers(); });
  const first = screen.getByRole("button", { name: "First" }); const last = screen.getByRole("button", { name: "Last" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: "Tab" }); expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(trigger);
});

function NestedScope({ close }: { close: () => void }) {
  const ref = useRef<HTMLDivElement>(null); const safe = useRef<HTMLButtonElement>(null);
  useFocusTrap({ open: true, containerRef: ref, onClose: close, initialFocusRef: safe });
  return createPortal(<div role="dialog" aria-label="Child" tabIndex={-1} ref={ref}><button>Discard</button><button ref={safe}>Keep editing</button></div>, document.body);
}
function NestedExample() {
  const [open, setOpen] = useState(false); const [child, setChild] = useState(false); const ref = useRef<HTMLDivElement>(null);
  useFocusTrap({ open, containerRef: ref, onClose: () => setOpen(false) });
  return <><button onClick={() => setOpen(true)}>Open parent</button>{open ? <div role="dialog" aria-label="Parent" tabIndex={-1} ref={ref}><button onClick={() => setChild(true)}>Open child</button>{child ? <NestedScope close={() => setChild(false)} /> : null}</div> : null}</>;
}
it("gives a new portalled child focus and Escape ownership before any timer can run", () => {
  vi.useFakeTimers(); render(<NestedExample />);
  const trigger = screen.getByRole("button", { name: "Open parent" }); trigger.focus(); fireEvent.click(trigger);
  const childTrigger = screen.getByRole("button", { name: "Open child" });
  expect(document.activeElement).toBe(childTrigger);
  fireEvent.click(childTrigger);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep editing" }));
  // A document-originating event also belongs only to the top scope.
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Child" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Parent" })).toBeTruthy();
  expect(document.activeElement).toBe(childTrigger);
  fireEvent.keyDown(childTrigger, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(trigger);
});
