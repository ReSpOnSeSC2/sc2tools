import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChromeProvider, useChromeBreadcrumb, useChromeContext } from "../ChromeContext";
const nav = vi.hoisted(() => ({ path: "/app/game/a" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path }));
function Page() { useChromeBreadcrumb({ backHref: "/app", backLabel: "Back to Today", trail: [{ label: "Old game" }] }); return null; }
function Read() { return <p>{useChromeContext()?.breadcrumb?.trail[0].label || "No override"}</p>; }
afterEach(() => { cleanup(); nav.path = "/app/game/a"; });
it("does not expose a previous page's breadcrumb during navigation", () => {
  const view = render(<ChromeProvider><Page /><Read /></ChromeProvider>); expect(screen.getByText("Old game")).toBeTruthy();
  nav.path = "/app/game/b"; view.rerender(<ChromeProvider><Page /><Read /></ChromeProvider>); expect(screen.getByText("No override")).toBeTruthy();
});
it("is harmless without the app chrome", () => { expect(() => render(<Page />)).not.toThrow(); });
