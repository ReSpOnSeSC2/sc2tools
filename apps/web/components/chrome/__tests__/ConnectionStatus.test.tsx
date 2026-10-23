import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import useSWR, { SWRConfig } from "swr";

const harness = vi.hoisted(() => ({ pathname: "/app" }));
vi.mock("next/navigation", () => ({ usePathname: () => harness.pathname }));

import {
  ConnectionBanner,
  ConnectionStatusProvider,
  FAILURE_THRESHOLD,
  PING_INTERVAL_MS,
} from "../ConnectionStatus";

const BANNER_TEXT = "Reconnecting to SC2 Tools… your data is safe.";

/** One SWR read whose outcome the test controls through `outcomes`. */
function Probe({ id, outcomes }: { id: string; outcomes: Map<string, () => Promise<unknown>> }) {
  const { data, error } = useSWR(id, () => outcomes.get(id)!());
  return <p>{`${id}:${data ? "ok" : error ? "failed" : "loading"}`}</p>;
}

function renderApp(ids: string[], outcomes: Map<string, () => Promise<unknown>>) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <ConnectionStatusProvider>
        <ConnectionBanner />
        {ids.map((id) => (
          <Probe key={id} id={id} outcomes={outcomes} />
        ))}
      </ConnectionStatusProvider>
    </SWRConfig>,
  );
}

const offline = () => Promise.reject(new TypeError("Failed to fetch"));
const notFound = () => Promise.reject({ status: 404, code: "not_found", message: "Not found." });
const ok = () => Promise.resolve({ ok: true });

beforeEach(() => {
  harness.pathname = "/app";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ConnectionBanner", () => {
  it("stays hidden while requests succeed", async () => {
    renderApp(["a"], new Map([["a", ok]]));
    await screen.findByText("a:ok");
    expect(screen.queryByText(BANNER_TEXT)).toBeNull();
  });

  it(`appears after ${FAILURE_THRESHOLD} connection failures in a row`, async () => {
    const ids = Array.from({ length: FAILURE_THRESHOLD }, (_, i) => `r${i}`);
    renderApp(ids, new Map(ids.map((id) => [id, offline])));
    expect(await screen.findByText(BANNER_TEXT)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(BANNER_TEXT);
  });

  it("restarts the count when the server answers, even with an error", async () => {
    // Three connection failures, but a 404 in the middle proves the
    // server is up, so they are not three in a row.
    const outcomes = new Map<string, () => Promise<unknown>>([
      ["a", offline],
      ["b", offline],
      ["c", notFound],
      ["d", offline],
    ]);
    renderApp(["a", "b", "c", "d"], outcomes);
    for (const id of ["a", "b", "c", "d"]) await screen.findByText(`${id}:failed`);
    expect(screen.queryByText(BANNER_TEXT)).toBeNull();
  });

  it("appears at once when the browser is offline", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    renderApp([], new Map());
    expect(screen.getByText(BANNER_TEXT)).toBeTruthy();
  });

  it("keeps reconnecting when the same-origin stats proxy returns its cached fallback", async () => {
    const ids = ["a", "b", "c", "/api/site/stats"];
    renderApp(ids, new Map(ids.map((id) => [id, id.startsWith("/api/") ? ok : offline])));
    await screen.findByText("/api/site/stats:ok");
    expect(await screen.findByText(BANNER_TEXT)).toBeTruthy();
  });

  it("is never shown on the overlay or dock pages", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    for (const pathname of ["/overlay/token-123", "/dock/token-123"]) {
      harness.pathname = pathname;
      const view = renderApp([], new Map());
      expect(screen.queryByText(BANNER_TEXT)).toBeNull();
      expect(screen.queryByTestId("connection-banner")).toBeNull();
      view.unmount();
    }
  });

  it("pings the API while unreachable and recovers the failed sections when it answers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const ids = Array.from({ length: FAILURE_THRESHOLD }, (_, i) => `r${i}`);
    const outcomes = new Map<string, () => Promise<unknown>>(ids.map((id) => [id, offline]));
    renderApp(ids, outcomes);
    await screen.findByText(BANNER_TEXT);

    // The server is back.
    for (const id of ids) outcomes.set(id, ok);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/v1\/ping$/), { cache: "no-store" });
    expect(screen.queryByText(BANNER_TEXT)).toBeNull();
    for (const id of ids) expect(await screen.findByText(`${id}:ok`)).toBeTruthy();
  });
});
