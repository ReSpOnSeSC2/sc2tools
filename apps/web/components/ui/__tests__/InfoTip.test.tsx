import { useState, type AnchorHTMLAttributes } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InfoTip } from "../InfoTip";
import { Term } from "../Term";
import { Modal } from "../Modal";

const h = vi.hoisted(() => ({ failed: false, lookups: vi.fn() }));
vi.mock("@/lib/glossary", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/glossary")>();
  return { ...actual, glossaryTerm: (id: string) => {
    h.lookups(id); if (h.failed) throw new Error("Synthetic definition failure"); return actual.glossaryTerm(id);
  } };
});
vi.mock("next/link", async () => {
  const { forwardRef } = await import("react");
  return { default: forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(function Link({ children, ...props }, ref) { return <a ref={ref} {...props}>{children}</a>; }) };
});
beforeEach(() => { h.failed = false; h.lookups.mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("loads only on explicit open and links its named button to a nonmodal definition", async () => {
  render(<InfoTip termId="net-mmr" label="Net MMR" />);
  expect(h.lookups).not.toHaveBeenCalled(); expect(screen.queryByRole("dialog")).toBeNull();
  const trigger = screen.getByRole("button", { name: "About Net MMR" }); trigger.focus(); fireEvent.click(trigger);
  const panel = await screen.findByRole("dialog", { name: "About Net MMR" });
  const text = await within(panel).findByText(/MMR you gained or lost against an opponent/);
  expect(trigger.getAttribute("aria-expanded")).toBe("true"); expect(trigger.getAttribute("aria-controls")).toBe(panel.id);
  expect(trigger.getAttribute("aria-describedby")).toBe(text.id); expect(panel.hasAttribute("aria-modal")).toBe(false);
  expect(document.body.style.overflow).not.toBe("hidden");
  expect(within(panel).getByRole("link", { name: "Learn more" }).getAttribute("href")).toBe("/help/glossary#net-mmr");
  fireEvent.keyDown(document, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(trigger);
});

it("preserves an outside pointer action's focus", async () => {
  render(<><InfoTip termId="pulse-id" label="Pulse ID" /><button type="button">Outside action</button></>);
  const trigger = screen.getByRole("button", { name: "About Pulse ID" }); trigger.focus(); fireEvent.click(trigger);
  await screen.findByRole("link", { name: "Learn more" });
  const outside = screen.getByRole("button", { name: "Outside action" }); fireEvent.pointerDown(outside); outside.focus();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(document.activeElement).toBe(outside);
});

it("retries a failed definition without claiming it loaded and rejects unknown IDs", async () => {
  h.failed = true;
  const view = render(<InfoTip termId="net-mmr" label="Net MMR" />);
  fireEvent.click(screen.getByRole("button", { name: "About Net MMR" }));
  await screen.findByRole("alert"); expect(screen.queryByRole("link", { name: "Learn more" })).toBeNull();
  h.failed = false; const retry = screen.getByRole("button", { name: "Retry definition" }); retry.focus(); fireEvent.click(retry);
  const more = await screen.findByRole("link", { name: "Learn more" }); expect(document.activeElement).toBe(more); expect(h.lookups).toHaveBeenCalledTimes(2);
  view.rerender(<InfoTip termId="not-a-term" label="Unknown term" />);
  await screen.findByRole("alert"); expect(screen.queryByRole("link", { name: "Learn more" })).toBeNull();
  expect(screen.getByRole("button", { name: "About Unknown term" }).hasAttribute("aria-describedby")).toBe(false);
});

it("dismisses the tip before its parent Modal and keeps the parent's scroll lock", async () => {
  function Host() { const [open, setOpen] = useState(false); return <><button type="button" onClick={() => setOpen(true)}>Open parent</button>
    <Modal open={open} onClose={() => setOpen(false)} title="Parent"><InfoTip termId="toon" label="Toon" /></Modal></>; }
  render(<Host />); const opener = screen.getByRole("button", { name: "Open parent" }); opener.focus(); fireEvent.click(opener);
  const trigger = screen.getByRole("button", { name: "About Toon" }); trigger.focus(); fireEvent.click(trigger);
  await screen.findByRole("link", { name: "Learn more" }); fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "About Toon" })).toBeNull(); expect(document.activeElement).toBe(trigger);
  expect(screen.getByRole("dialog", { name: "Parent" })).toBeTruthy(); expect(document.body.style.overflow).toBe("hidden");
  fireEvent.keyDown(document, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(opener);
});

it("renders a readable dotted term with a separate named control", async () => {
  render(<Term id="pulse-id">Pulse ID</Term>);
  expect(screen.getByText("Pulse ID").className).toContain("decoration-dotted");
  const trigger = screen.getByRole("button", { name: "About Pulse ID" }); fireEvent.click(trigger);
  await screen.findByRole("link", { name: "Learn more" }); expect(h.lookups).toHaveBeenCalledWith("pulse-id");
});
