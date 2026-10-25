import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { AccountFilterPicker } from "../AccountFilterPicker";
import { FiltersContext, type AnalyzerFilters } from "@/lib/filterContext";
const h = vi.hoisted(() => ({ auth: { isLoaded: true, isSignedIn: true, userId: "owner" as string | null }, data: { items: [] as unknown[] }, previous: false, error: undefined as unknown, mutate: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => h.auth }));
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ data: h.data, error: h.error, isPreviousData: h.previous, mutate: h.mutate }) }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
function Host({ accounts }: { accounts?: string }) {
  const [filters, setFilters] = useState<AnalyzerFilters>({ accounts });
  return <FiltersContext.Provider value={{ filters, setFilters, dbRev: 0, bumpRev: () => {}, seasons: [] }}><AccountFilterPicker /><output data-testid="cohort">{filters.accounts ?? "all"}</output></FiltersContext.Provider>;
}
beforeEach(() => {
  Object.assign(h.auth, { isLoaded: true, isSignedIn: true, userId: "owner" }); h.previous = false; h.error = undefined; h.mutate.mockReset();
  h.data = { items: [{ handle: "2-S2-1-1", label: "Main", region: "EU", leagueId: 5, mmr: 4800 }, { handle: "1-S2-1-2", label: "Alt", region: "NA", leagueId: null, mmr: null }] };
});
afterEach(cleanup);
describe("account picker", () => {
  it("applies literal account checkboxes, accessible labels and clear-to-all", () => {
    render(<Host />);
    fireEvent.click(screen.getByText("Account · All accounts"));
    fireEvent.click(screen.getByRole("checkbox", { name: /Main · EU · Master/ }));
    expect(screen.getByRole("status").textContent).toBe("2-S2-1-1");
    fireEvent.click(screen.getByRole("checkbox", { name: /Alt · NA/ }));
    expect(screen.getByRole("status").textContent).toBe("1-S2-1-2,2-S2-1-1");
    fireEvent.click(screen.getByRole("button", { name: "All accounts" })); expect(screen.getByRole("status").textContent).toBe("all");
  });
  it("hides single-account controls and all private choices during auth loading/signout", () => {
    h.data.items = h.data.items.slice(0, 1); const view = render(<Host />); expect(screen.queryByText(/Account ·/)).toBeNull();
    h.data.items = [{ handle: "1-S2-1-1" }, { handle: "2-S2-1-2" }]; h.auth.isLoaded = false; view.rerender(<Host />);
    expect(screen.queryByText(/Account ·/)).toBeNull(); h.auth.isLoaded = true; h.auth.isSignedIn = false; view.rerender(<Host />); expect(screen.queryByText(/Account ·/)).toBeNull();
  });
  it("retains an active unknown handle and retry without clearing its selection", () => {
    h.error = { status: 503 }; h.data.items = []; render(<Host accounts="2-S2-1-1" />);
    fireEvent.click(screen.getByText("Account · 1 selected"));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry" })); expect(h.mutate).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox")); expect(screen.getByTestId("cohort").textContent).toBe("all");
  });
});
