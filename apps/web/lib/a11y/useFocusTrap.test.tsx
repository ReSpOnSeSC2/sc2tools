import { useRef, useState } from "react";
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
