import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyzerView, AnalyzerViewPrefs } from "@/lib/analyzerViews";

const harness = vi.hoisted(() => ({
  userId: "owner-a", pathname: "/app/maps", filters: {} as Record<string, unknown>,
  prefs: { views: [], defaultViewId: null } as AnalyzerViewPrefs,
  apiCall: vi.fn(), getToken: vi.fn(), replace: vi.fn(), mutate: vi.fn(),
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: harness.userId, getToken: harness.getToken }) }));
vi.mock("next/navigation", () => ({ usePathname: () => harness.pathname, useRouter: () => ({ replace: harness.replace }) }));
vi.mock("@/lib/filterContext", () => ({ useFilters: () => ({ filters: harness.filters }) }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock("@/lib/clientApi", async () => {
  const { useState } = await import("react");
  return {
    apiCall: harness.apiCall,
    useApi: () => {
      const [data, setData] = useState(harness.prefs);
      return { data, isLoading: false, error: undefined, mutate: async (next: AnalyzerViewPrefs) => { harness.mutate(next); harness.prefs = next; setData(next); } };
    },
  };
});
import { AnalyzerViewsDialog } from "../AnalyzerViewsDialog";

function saved(): AnalyzerView { return { id: "one", name: "PvZ season", section: "replays", filters: { race: "P", opp_race: "Z", preset: "season:67" } }; }
function body() { return JSON.parse(harness.apiCall.mock.calls.at(-1)![2].body) as AnalyzerViewPrefs; }
beforeEach(() => {
  harness.userId = "owner-a"; harness.pathname = "/app/maps";
  harness.prefs = { views: [], defaultViewId: null };
  harness.filters = { preset: "season:67", race: "P", build: "Pressure", map: "Alpha", map_exact: '["Alpha","Alpha LE"]', map_exact_label: "Alpha", authorization: "private" };
  harness.apiCall.mockReset(); harness.mutate.mockReset(); harness.replace.mockReset(); harness.getToken.mockReset().mockResolvedValue("token");
  harness.apiCall.mockImplementation(async (_token, _path, init) => JSON.parse(init.body));
});
afterEach(cleanup);

describe("saved analyzer views", () => {
  it("saves the current section and bounded filter snapshot without unrelated fields", async () => {
    render(<AnalyzerViewsDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("View name"), { target: { value: "  Season maps  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    await screen.findByText("View saved.");
    expect(body().views[0]).toMatchObject({ name: "Season maps", section: "maps", filters: { preset: "season:67", race: "P", build: "Pressure", map_exact: '["Alpha","Alpha LE"]' } });
    expect(body().views[0].filters).not.toHaveProperty("authorization");
    expect(harness.apiCall.mock.calls[0][1]).toBe("/v1/me/preferences/analyzerViews");
    expect((screen.getByLabelText("View name") as HTMLInputElement).value).toBe("");
  });

  it("renames without replacing the saved filters or section with the current cohort", async () => {
    harness.prefs = { views: [saved()], defaultViewId: "one" };
    render(<AnalyzerViewsDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename PvZ season" }));
    fireEvent.change(screen.getByLabelText("Rename view"), { target: { value: "Practice" } });
    fireEvent.click(screen.getByRole("button", { name: /^Rename$/ }));
    await screen.findByText("View renamed.");
    expect(body()).toEqual({ views: [{ ...saved(), name: "Practice" }], defaultViewId: "one" });
  });

  it("sets a default, then deletes it without an orphaned default pointer", async () => {
    harness.prefs = { views: [saved()], defaultViewId: null };
    render(<AnalyzerViewsDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set PvZ season as default" }));
    await screen.findByText("Default view set.");
    expect(body().defaultViewId).toBe("one");
    fireEvent.click(screen.getByRole("button", { name: "Delete PvZ season" }));
    await screen.findByText("View deleted.");
    expect(body()).toEqual({ views: [], defaultViewId: null });
  });

  it("applies through the URL without a preference write", () => {
    harness.prefs = { views: [saved()], defaultViewId: null };
    const close = vi.fn(); render(<AnalyzerViewsDialog onClose={close} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply PvZ season" }));
    const [href, options] = harness.replace.mock.calls[0];
    expect(href).toContain("/app/replays?filters=1");
    expect(href).toContain("preset=season%3A67"); expect(options).toEqual({ scroll: false });
    expect(close).toHaveBeenCalledOnce(); expect(harness.apiCall).not.toHaveBeenCalled();
  });

  it("rejects duplicate names and the thirteenth view before making a request", () => {
    harness.prefs = { views: Array.from({ length: 12 }, (_, i) => ({ ...saved(), id: `view-${i}`, name: `View ${i}` })), defaultViewId: null };
    render(<AnalyzerViewsDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("View name"), { target: { value: "view 0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    expect(screen.getByRole("alert").textContent).toContain("already exists");
    fireEvent.change(screen.getByLabelText("View name"), { target: { value: "Another" } });
    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    expect(screen.getByRole("alert").textContent).toContain("up to 12"); expect(harness.apiCall).not.toHaveBeenCalled();
  });

  it("retains the draft after a failed save and allows a retry", async () => {
    harness.apiCall.mockRejectedValueOnce({ message: "Connection lost. Try again." });
    render(<AnalyzerViewsDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("View name"), { target: { value: "Keep my draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    await screen.findByRole("alert"); expect((screen.getByLabelText("View name") as HTMLInputElement).value).toBe("Keep my draft");
    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    await screen.findByText("View saved."); expect(harness.apiCall).toHaveBeenCalledTimes(2);
  });

  it("resets drafts on account switch and fences a token that resolves for the previous owner", async () => {
    let resolveToken!: (token: string) => void;
    harness.getToken.mockImplementation(() => new Promise<string>(resolve => { resolveToken = resolve; }));
    harness.apiCall.mockImplementation(async token => { await token(); throw new Error("Should not send a write"); });
    const view = render(<AnalyzerViewsDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("View name"), { target: { value: "Owner A draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    harness.userId = "owner-b"; view.rerender(<AnalyzerViewsDialog onClose={vi.fn()} />);
    expect((screen.getByLabelText("View name") as HTMLInputElement).value).toBe("");
    await act(async () => resolveToken("old-owner-token"));
    await waitFor(() => expect(harness.mutate).not.toHaveBeenCalled());
    expect(screen.queryByText("View saved.")).toBeNull();
  });
});
