import { useState, type AnchorHTMLAttributes, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileNav } from "../MobileNav";
import { Modal } from "@/components/ui/Modal";
import { lockBodyScroll } from "@/lib/bodyScrollLock";
const clerk = vi.hoisted(() => ({ signedIn: false }));
vi.mock("next/link", () => ({ default: ({ children, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} onClick={event => { event.preventDefault(); onClick?.(event); }}>{children}</a> }));
vi.mock("@clerk/nextjs", () => ({ SignedIn: ({ children }: { children: ReactNode }) => clerk.signedIn ? children : null, SignedOut: ({ children }: { children: ReactNode }) => clerk.signedIn ? null : children }));
const closed = vi.fn();
let desktop = false;
const desktopListeners = new Set<() => void>();
const extraLocks: Array<() => void> = [];
function Host({ revision = 0 }: { revision?: number }) {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Open navigation fixture</button><MobileNav open={open} onClose={() => { closed(revision); setOpen(false); }} pathname="/" links={[{ href: "/help", label: "Help", auth: "any" }]} /></>;
}
beforeEach(() => {
  closed.mockClear(); clerk.signedIn = false; desktop = false; desktopListeners.clear(); localStorage.clear();
  document.documentElement.removeAttribute("data-theme-mode"); document.documentElement.removeAttribute("data-theme");
  vi.stubGlobal("matchMedia", (query: string) => query === "(min-width:1024px)" ? {
    get matches() { return desktop; },
    addEventListener: (_event: string, listener: () => void) => desktopListeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => desktopListeners.delete(listener),
  } : { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { cleanup(); extraLocks.splice(0).forEach(unlock => unlock()); vi.unstubAllGlobals(); });
async function open() { const trigger = screen.getByRole("button", { name: "Open navigation fixture" }); trigger.focus(); fireEvent.click(trigger); const dialog = screen.getByRole("dialog", { name: "Site navigation" }); await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true)); return { trigger, dialog }; }
it("traps Tab from the selected radio, excluding non-tabstop alternatives", async () => {
  render(<Host />); const { dialog } = await open();
  const light = within(dialog).getByRole("radio", { name: "Light" }); fireEvent.click(light); light.focus();
  fireEvent.keyDown(document, { key: "Tab" }); expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
  fireEvent.keyDown(document, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(light);
});
it("retains the original return target when the parent replaces its close callback", async () => {
  const view = render(<Host />); const { trigger, dialog } = await open(); const light = within(dialog).getByRole("radio", { name: "Light" }); light.focus();
  view.rerender(<Host revision={1} />); expect(document.activeElement).toBe(light);
  fireEvent.keyDown(document, { key: "Escape" }); expect(closed).toHaveBeenCalledWith(1); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(trigger);
});
it("brings escaped keyboard focus back into the drawer", async () => {
  render(<Host />); const { trigger, dialog } = await open(); trigger.focus(); fireEvent.keyDown(document, { key: "Tab" });
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
});

it.each(["close", "scrim", "destination", "home"] as const)("closes by %s, releases its lock and returns to the trigger", async (method) => {
  render(<Host />); const { trigger, dialog } = await open();
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
  expect(document.body.style.overflow).toBe("hidden");
  expect(dialog.contains(document.getElementById("mobile-nav-drawer"))).toBe(true);
  const target = method === "close" ? within(dialog).getByRole("button", { name: "Close" })
    : method === "scrim" ? screen.getByRole("button", { name: "Close dialog" })
      : within(dialog).getByRole("link", { name: method === "home" ? "SC2 Tools — home" : "Help" });
  fireEvent.click(target);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(document.body.style.overflow).not.toBe("hidden");
});

it("closes at the desktop breakpoint using the latest callback and removes the listener", async () => {
  const view = render(<Host />); await open();
  expect(desktopListeners.size).toBe(1);
  view.rerender(<Host revision={2} />);
  act(() => { desktop = true; desktopListeners.forEach(listener => listener()); });
  expect(closed).toHaveBeenCalledWith(2);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.style.overflow).not.toBe("hidden");
  expect(desktopListeners.size).toBe(0);
});

it("does not retain a lock when opened while the desktop breakpoint already matches", async () => {
  desktop = true; render(<Host />);
  fireEvent.click(screen.getByRole("button", { name: "Open navigation fixture" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(closed).toHaveBeenCalledTimes(1);
  expect(document.body.style.overflow).not.toBe("hidden");
});

it("dismisses its top layer before its parent and keeps another body's lock until its owner releases it", async () => {
  function Parent() {
    const [parent, setParent] = useState(false);
    return <><button type="button" onClick={() => setParent(true)}>Open parent</button>
      <Modal open={parent} onClose={() => setParent(false)} title="Parent"><Host /></Modal></>;
  }
  const unlock = lockBodyScroll(); extraLocks.push(unlock);
  render(<Parent />);
  const parentTrigger = screen.getByRole("button", { name: "Open parent" }); parentTrigger.focus(); fireEvent.click(parentTrigger);
  const { trigger } = await open();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Site navigation" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Parent" })).toBeTruthy();
  expect(document.activeElement).toBe(trigger);
  expect(document.body.style.overflow).toBe("hidden");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(parentTrigger);
  expect(document.body.style.overflow).toBe("hidden");
  extraLocks.splice(extraLocks.indexOf(unlock), 1); unlock();
  expect(document.body.style.overflow).not.toBe("hidden");
});

it.each([false, true])("keeps the current audience's existing call to action (signed in %s)", async (signedIn) => {
  clerk.signedIn = signedIn; render(<Host />); const { dialog } = await open();
  expect(within(dialog).getByRole("link", { name: "Help" }).getAttribute("href")).toBe("/help");
  if (signedIn) {
    expect(within(dialog).getByRole("link", { name: "Open app" }).getAttribute("href")).toBe("/app");
    expect(within(dialog).queryByRole("link", { name: "Sign in" })).toBeNull();
  } else {
    expect(within(dialog).getByRole("link", { name: "Sign in" })).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Get started" })).toBeTruthy();
    expect(within(dialog).queryByRole("link", { name: "Open app" })).toBeNull();
  }
});
