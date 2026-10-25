import { cleanup, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "owner", isLoaded: true, isSignedIn: true, getToken: async () => "token" }) }));
import { useApi } from "@/lib/clientApi";
import { LadderContextCard } from "../LadderContextCard";
const fetcher = vi.fn();
const confirmed = { groupKey: "known", displayName: "Main", revision: 1, target: { key: "pulse:100", pulseCharacterId: "100" } };
function Preview({ show }: { show: boolean }) {
  const parent = useApi<{ intel: null }>("/v1/opponents/one/pulse-intel", { revalidateOnFocus: false });
  return <>{parent.data ? <p>Header cache warm</p> : null}{show ? <LadderContextCard pulseId="one" confirmedIdentity={confirmed}><p>Ladder child mounted</p></LadderContextCard> : null}</>;
}
beforeEach(() => { fetcher.mockReset().mockImplementation(async () => new Response(JSON.stringify({ intel: null }), { status: 200, headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("reuses the confirmed header's authoritative response after the dedupe interval expires", async () => {
  const cache = new Map();
  const element = (show: boolean) => <SWRConfig value={{ provider: () => cache, dedupingInterval: 1 }}><Preview show={show} /></SWRConfig>;
  const view = render(element(false)); await screen.findByText("Header cache warm");
  await new Promise(resolve => setTimeout(resolve, 30));
  view.rerender(element(true)); await screen.findByText("Ladder child mounted");
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(fetcher).toHaveBeenCalledOnce();
});
it("still fetches ladder data when an ordinary profile reaches the section", async () => {
  render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 1 }}><LadderContextCard pulseId="ordinary"><p>Ordinary ladder loaded</p></LadderContextCard></SWRConfig>);
  await screen.findByText("Ordinary ladder loaded");
  expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][0]).toContain("/v1/opponents/ordinary/pulse-intel");
});
