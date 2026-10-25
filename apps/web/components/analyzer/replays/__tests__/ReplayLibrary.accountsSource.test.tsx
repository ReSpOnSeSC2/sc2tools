import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReplayLibrary } from "../ReplayLibrary";
import { FiltersContext, type AnalyzerFilters } from "@/lib/filterContext";
import { ToastProvider } from "@/components/ui/Toast";
vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...rest}>{children}</a> }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "owner", isLoaded: true, isSignedIn: true, getToken: async () => "synthetic" }) }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock("@/lib/clientApi", async importOriginal => ({ ...(await importOriginal<typeof import("@/lib/clientApi")>()), API_BASE: "https://example.test", apiCall: vi.fn(), useApi: (path: string | null) => ({
  data: path?.startsWith("/v1/replays?") ? { profile: { displayName: "You" }, items: [{ gameId: "one", myRace: "Protoss", opponent: { displayName: "Rival", race: "Zerg" } }], page: { hasMore: false } } : path?.includes("replay-sharing") ? { enabled: false, handle: null } : undefined,
  isLoading: false, isValidating: false, isPreviousData: false, mutate: vi.fn(),
}) }));
function Host() {
  const [filters, setFilters] = useState<AnalyzerFilters>({ preset: "all", accounts: "2-S2-1-1", race: "P", build: "Pressure" });
  return <ToastProvider><FiltersContext.Provider value={{ filters, setFilters, dbRev: 0, bumpRev: () => {}, seasons: [] }}>
    <button onClick={() => setFilters({ ...filters, accounts: undefined })}>Clear account</button><ReplayLibrary />
  </FiltersContext.Provider></ToastProvider>;
}
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });
it("clears account membership in actual game links immediately while the durable URL still has the old account", () => {
  const href = "/app/replays?accounts=2-S2-1-1&replaySearch=Rival&replayResult=win&replayMatchup=PvZ";
  window.history.replaceState(null, "", href);
  render(<Host />);
  const source = () => new URL(screen.getAllByRole("link", { name: /Open replay analysis/ })[0].getAttribute("href")!, "https://example.test").searchParams;
  expect(new URLSearchParams(source().get("fromFilters")!).get("accounts")).toBe("2-S2-1-1");
  fireEvent.click(screen.getByRole("button", { name: "Clear account" }));
  const actual = new URLSearchParams(source().get("fromFilters")!);
  expect(window.location.search).toContain("accounts=");
  expect(actual.has("accounts")).toBe(false);
  expect(actual.get("q")).toBe("Rival"); expect(actual.get("result")).toBe("win"); expect(actual.get("matchup")).toBe("PvZ");
  expect(actual.get("race")).toBe("P"); expect(actual.get("build")).toBe("Pressure");
  expect(source().get("from")).toBe(href);
});
