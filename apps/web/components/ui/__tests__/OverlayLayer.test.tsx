import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useRef, useState } from "react";
import { Modal } from "../Modal";
import { Popover } from "../Popover";
import { OverlayLayerProvider, useOverlayLayer } from "../OverlayLayer";
afterEach(cleanup);
it("keeps a body child Modal above its outside portal Popover and below Toast", () => {
  function Child() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Open child modal</button><Modal open={open} onClose={() => setOpen(false)} title="Child">Child content</Modal></>;
  }
  function Example() {
    const anchor = useRef<HTMLButtonElement>(null), [open, setOpen] = useState(false);
    return <Modal open onClose={() => {}} title="Parent"><button ref={anchor} onClick={() => setOpen(true)}>Open options</button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} label="Options" portalContainer={document.body}><Child /></Popover></Modal>;
  }
  render(<Example />); fireEvent.click(screen.getByRole("button", { name: "Open options" })); fireEvent.click(screen.getByRole("button", { name: "Open child modal" }));
  const parent = screen.getByRole("dialog", { name: "Parent" }), popup = screen.getByRole("dialog", { name: "Options" }), child = screen.getByRole("dialog", { name: "Child" });
  expect(parent.parentElement!.style.zIndex).toBe("50"); expect(popup.style.zIndex).toBe("51"); expect(child.parentElement!.style.zIndex).toBe("52");
  expect(Number(child.parentElement!.style.zIndex)).toBeLessThan(60);
});
it("bounds deep nesting below the global Toast layer", () => {
  function Value() { return <output>{useOverlayLayer()}</output>; }
  render(<OverlayLayerProvider value={59}><Value /></OverlayLayerProvider>);
  expect(screen.getByRole("status").textContent).toBe("59");
});
