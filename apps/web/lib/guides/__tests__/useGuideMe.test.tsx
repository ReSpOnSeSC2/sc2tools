import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import { useGuideMe } from "../useGuideMe";
import { FIXTURE_ME } from "../__fixtures__";
const h = vi.hoisted(() => ({ signedIn: true, loaded: true, token: vi.fn(async () => "test-token") }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: h.loaded, isSignedIn: h.signedIn, userId: h.signedIn ? "guide-test-owner" : null, getToken: h.token }) }));
function Consumer({ label }: { label: string }) { const query = useGuideMe("pvz", "stargate-into-glaives"); return <p>{label}: {query.data?.games ?? "waiting"}</p>; }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); h.signedIn = true; h.loaded = true; h.token.mockClear(); });
it("deduplicates the personal record and timing islands into one authenticated no-store request", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(FIXTURE_ME), { headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", fetcher);
  render(<SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false }}><Consumer label="Record" /><Consumer label="Table" /></SWRConfig>);
  await screen.findByText("Record: 37"); await screen.findByText("Table: 37"); expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/v1/guides/me/pvz/stargate-into-glaives"), expect.objectContaining({ cache: "no-store", headers: { authorization: "Bearer test-token" } }));
});
it("does not request private numbers before auth resolves or while signed out", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); h.loaded = false; h.signedIn = false;
  const view = render(<SWRConfig value={{ provider: () => new Map() }}><Consumer label="Record" /></SWRConfig>); expect(screen.getByText("Record: waiting")).toBeTruthy(); h.loaded = true; view.rerender(<SWRConfig value={{ provider: () => new Map() }}><Consumer label="Record" /></SWRConfig>); await waitFor(() => expect(fetcher).not.toHaveBeenCalled()); expect(h.token).not.toHaveBeenCalled();
});
