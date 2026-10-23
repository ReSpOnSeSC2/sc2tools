import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminShell, NAV_GROUPS } from "./AdminShell";
import { AdminPagination } from "./AdminPagination";
import { AdminPageHeader } from "./AdminPageHeader";
import { ForbiddenCard } from "./AdminFragments";

const mocks = vi.hoisted(() => ({ pathname: "/admin/users/example", scroll: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ data: { unreadCount: 0, overallStatus: "ok" }, mutate: vi.fn() }) }));
vi.mock("./useAdminEventsSocket", () => ({ useAdminEventsSocket: () => undefined }));
const originalScroll = HTMLElement.prototype.scrollIntoView;
beforeEach(() => { mocks.pathname = "/admin/users/example"; mocks.scroll.mockClear(); HTMLElement.prototype.scrollIntoView = mocks.scroll; });
afterEach(() => { cleanup(); HTMLElement.prototype.scrollIntoView = originalScroll; vi.unstubAllGlobals(); });

describe("admin navigation and page primitives", () => {
  it("respects reduced motion on the first mobile scroll", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    render(<AdminShell>Page</AdminShell>);
    expect(mocks.scroll.mock.calls.every(([options]) => options.behavior === "auto")).toBe(true);
  });
  it("has five labelled groups, thirteen unique icons, longest-prefix selection and mobile scrolling", () => {
    expect(NAV_GROUPS).toHaveLength(5);
    const items = NAV_GROUPS.flatMap((group) => [...group.items]);
    expect(items).toHaveLength(14);
    expect(new Set(items.map((item) => item.icon)).size).toBe(14);
    const { rerender } = render(<AdminShell>Page</AdminShell>);
    expect(screen.getByRole("list", { name: "Community" })).toBeTruthy();
    const mobile = screen.getByRole("navigation", { name: "Admin sections" });
    expect(within(mobile).getByRole("link", { name: "Users" }).getAttribute("aria-current")).toBe("page");
    expect(mocks.scroll).toHaveBeenLastCalledWith({ inline: "center", block: "nearest", behavior: "smooth" });
    mocks.pathname = "/admin/global-trends";
    rerender(<AdminShell>Page</AdminShell>);
    expect(within(mobile).getByRole("link", { name: "Global trends" }).getAttribute("aria-current")).toBe("page");
    expect(mocks.scroll).toHaveBeenCalledTimes(2);
    expect(within(screen.getByRole("list", { name: "Content" })).getByRole("link", { name: "Announcements" }).getAttribute("href")).toBe("/admin/announcements");
    mocks.pathname = "/admin/announcements"; rerender(<AdminShell>Page</AdminShell>);
    expect(within(mobile).getByRole("link", { name: "Announcements" }).getAttribute("aria-current")).toBe("page");
  });

  it("hides empty pagination, displays its label, and respects busy/disabled actions", () => {
    const prev = vi.fn(); const next = vi.fn();
    const props = { hasPrev: false, hasNext: true, onPrev: prev, onNext: next, label: "51–100 of 1,234", itemCount: 0 };
    const { rerender } = render(<AdminPagination {...props} />);
    expect(screen.queryByRole("navigation")).toBeNull();
    rerender(<AdminPagination {...props} hasPrev itemCount={50} />);
    expect(screen.getByText("51–100 of 1,234")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(prev).toHaveBeenCalledTimes(1);
    rerender(<AdminPagination {...props} hasPrev itemCount={50} loading />);
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Next" }).getAttribute("aria-busy")).toBe("true");
  });

  it("renders one h1 and help, while forbidden copy shows no header actions", () => {
    const { rerender } = render(<AdminPageHeader title="Users" description="Find an account." anchor="users-and-repairing-data" />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("link", { name: /Help/ }).getAttribute("target")).toBe("_blank");
    rerender(<ForbiddenCard />);
    expect(screen.getByText(/Admin → Users → your account → Grant admin/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Help/ })).toBeNull();
  });
});

describe("admin documentation and metadata contracts", () => {
  const adminRoot = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(adminRoot, "../../../..");
  const sourceFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry): string[] => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [full] : [];
  });
  it("gives every admin page a non-default segment title without user PII", () => {
    for (const page of sourceFiles(adminRoot).filter((file) => path.basename(file) === "page.tsx")) {
      const layout = path.join(path.dirname(page), "layout.tsx");
      expect(existsSync(layout), page).toBe(true);
      const source = readFileSync(layout, "utf8");
      expect(source, layout).toMatch(/title:\s*"[^"\n]+ · Admin"/);
      expect(source, layout).toMatch(/index:\s*false/);
      expect(source, layout).not.toContain("email");
    }
  });
  it("resolves every admin Help anchor against a real guide heading", () => {
    const doc = readFileSync(path.join(repoRoot, "docs/admin-console.md"), "utf8");
    const headings = [...doc.matchAll(/^## (.+)$/gm)].map((match) => match[1].toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").trim());
    for (const file of sourceFiles(adminRoot)) {
      for (const usage of readFileSync(file, "utf8").matchAll(/<(?:AdminPageHeader|PageHeader|AdminHelpLink)\b[^>]*?anchor="([^"]+)"/g)) {
        expect(headings, `${file}: ${usage[1]}`).toContain(usage[1]);
      }
    }
  });
});
