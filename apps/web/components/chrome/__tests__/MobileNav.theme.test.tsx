import { useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileNav } from "../MobileNav";
vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: ReactNode }) => <a {...props}>{children}</a> }));
vi.mock("@clerk/nextjs", () => ({ SignedIn: () => null, SignedOut: ({ children }: { children: ReactNode }) => children }));
const closed = vi.fn();
function Host({ revision = 0 }: { revision?: number }) {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Open navigation fixture</button><MobileNav open={open} onClose={() => { closed(revision); setOpen(false); }} pathname="/" links={[{ href: "/help", label: "Help", auth: "any" }]} /></>;
}
beforeEach(() => { closed.mockClear(); localStorage.clear(); document.documentElement.removeAttribute("data-theme-mode"); document.documentElement.removeAttribute("data-theme"); vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function open() { const trigger = screen.getByRole("button", { name: "Open navigation fixture" }); trigger.focus(); fireEvent.click(trigger); const dialog = screen.getByRole("dialog", { name: "Site navigation" }); await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true)); return { trigger, dialog }; }
it("traps Tab from the selected radio, excluding non-tabstop alternatives", async () => {
  render(<Host />); const { dialog } = await open();
  const light = within(dialog).getByRole("radio", { name: "Light" }); fireEvent.click(light); light.focus();
  fireEvent.keyDown(document, { key: "Tab" }); expect(document.activeElement).toBe(within(dialog).getByRole("link", { name: "SC2 Tools — home" }));
  fireEvent.keyDown(document, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(light);
});
it("retains the original return target when the parent replaces its close callback", async () => {
  const view = render(<Host />); const { trigger, dialog } = await open(); const light = within(dialog).getByRole("radio", { name: "Light" }); light.focus();
  view.rerender(<Host revision={1} />); expect(document.activeElement).toBe(light);
  fireEvent.keyDown(document, { key: "Escape" }); expect(closed).toHaveBeenCalledWith(1); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(trigger);
});
it("brings escaped keyboard focus back into the drawer", async () => {
  render(<Host />); const { trigger, dialog } = await open(); trigger.focus(); fireEvent.keyDown(document, { key: "Tab" });
  expect(document.activeElement).toBe(within(dialog).getByRole("link", { name: "SC2 Tools — home" }));
});
