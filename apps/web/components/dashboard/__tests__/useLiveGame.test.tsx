import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";

/**
 * SSE hook test. We mock ``@clerk/nextjs`` so ``useAuth`` resolves
 * synchronously, then drive ``fetch`` to hand back a controllable
 * ReadableStream. Each test gets a fresh fetch mock so the hook's
 * reconnect path (which fires the next ``connect()`` after a close)
 * never tries to re-read a previously-consumed stream.
 */

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: true,
    getToken: async () => "test-token",
  }),
}));

type StreamHandle = {
  push: (chunk: string) => void;
  close: () => void;
  err: (error: unknown) => void;
};

function makeStream(): { stream: ReadableStream<Uint8Array>; handle: StreamHandle } {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  const handle: StreamHandle = {
    push(chunk) {
      controller?.enqueue(encoder.encode(chunk));
    },
    close() {
      try {
        controller?.close();
      } catch {
        /* already closed */
      }
    },
    err(error) {
      try {
        controller?.error(error);
      } catch {
        /* already errored */
      }
    },
  };
  return { stream, handle };
}

/**
 * Build a fetch mock whose first call returns a controllable stream
 * we own; subsequent calls (the hook's reconnect path) return a never-
 * resolving promise so they sit idle for the rest of the test.
 */
function mockFetchOnce(): StreamHandle {
  const { stream, handle } = makeStream();
  let calls = 0;
  globalThis.fetch = vi.fn(async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    // Block reconnects so we don't race a re-consumed stream.
    return new Promise<Response>(() => {});
  }) as typeof globalThis.fetch;
  return handle;
}

type Snapshot = {
  live: unknown;
  lastUpdatedAt: number | null;
  connected: boolean;
};

describe("useLiveGame", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("parses each SSE data frame into a LiveGameEnvelope", async () => {
    const handle = mockFetchOnce();
    const { useLiveGame } = await import("@/lib/useLiveGame");
    const seen: Snapshot[] = [];
    function Probe() {
      const s = useLiveGame();
      useEffect(() => {
        seen.push({ ...s });
      });
      return null;
    }
    const { unmount } = render(<Probe />);
    // Drive the fetch promise + initial subscribe.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    handle.push(": ok\n\n");
    handle.push(
      `data: ${JSON.stringify({
        type: "liveGameState",
        phase: "match_loading",
        gameKey: "k",
        opponent: { name: "Maru" },
      })}\n\n`,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const last = seen[seen.length - 1];
    expect(last?.connected).toBe(true);
    expect(last?.live).toMatchObject({
      phase: "match_loading",
      opponent: { name: "Maru" },
    });

    handle.push(
      `data: ${JSON.stringify({
        type: "liveGameState",
        phase: "idle",
      })}\n\n`,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(seen[seen.length - 1].live).toBeNull();

    // Tear down before closing so the abort happens before any
    // reconnect timer can fire.
    unmount();
    handle.close();
  });

  it("ignores SSE comment / heartbeat lines without setting state", async () => {
    const handle = mockFetchOnce();
    const { useLiveGame } = await import("@/lib/useLiveGame");
    const seen: Snapshot[] = [];
    function Probe() {
      const s = useLiveGame();
      useEffect(() => {
        seen.push({ ...s });
      });
      return null;
    }
    const { unmount } = render(<Probe />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    handle.push(": ok\n\n");
    handle.push(": heartbeat\n\n");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(seen[seen.length - 1].connected).toBe(true);
    expect(seen[seen.length - 1].live).toBeNull();
    unmount();
    handle.close();
  });

  it("keeps state stable when the stream emits malformed JSON", async () => {
    const handle = mockFetchOnce();
    const { useLiveGame } = await import("@/lib/useLiveGame");
    const seen: Snapshot[] = [];
    function Probe() {
      const s = useLiveGame();
      useEffect(() => {
        seen.push({ ...s });
      });
      return null;
    }
    const { unmount } = render(<Probe />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    handle.push(`data: not-json\n\n`);
    handle.push(
      `data: ${JSON.stringify({
        type: "liveGameState",
        phase: "match_started",
        opponent: { name: "Cure" },
      })}\n\n`,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(seen[seen.length - 1].live).toMatchObject({
      phase: "match_started",
      opponent: { name: "Cure" },
    });
    unmount();
    handle.close();
  });
});
