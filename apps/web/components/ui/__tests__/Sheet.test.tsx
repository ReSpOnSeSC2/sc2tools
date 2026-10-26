import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Sheet } from "../Sheet";

afterEach(cleanup);
it.each(["bottom", "right"] as const)("keeps the %s sheet modal and restores focus/scroll after Escape", side => {
  function Example() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Open sheet</button><Sheet side={side} open={open} onClose={() => setOpen(false)} title="Controls"><button>Apply</button></Sheet></>;
  }
  document.body.style.overflow = "auto";
  render(<Example />);
  const opener = screen.getByRole("button", { name: "Open sheet" }); opener.focus(); fireEvent.click(opener);
  const dialog = screen.getByRole("dialog", { name: "Controls" });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(dialog.className).toContain(side === "right" ? "h-[100dvh]" : "max-h-[90dvh]");
  expect(dialog.parentElement!.className).toContain(side === "right" ? "items-stretch justify-end" : "items-end justify-center");
  expect(document.body.style.overflow).toBe("hidden");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(opener);
  expect(document.body.style.overflow).toBe("auto");
  document.body.style.overflow = "";
});
