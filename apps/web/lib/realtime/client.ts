import { io, type Socket } from "socket.io-client";
import { createGamesRefresh, gamesChanged } from "./gamesRefresh";

export type RealtimeState = {
  status: "connecting" | "connected" | "reconnecting" | "offline";
  attempts: number;
  lastConnectedAt: number | null;
  bulk: boolean;
};
export const INITIAL_REALTIME: RealtimeState = { status: "connecting", attempts: 0, lastConnectedAt: null, bulk: false };
export type RealtimeHandlers = Record<string, (payload: unknown) => void>;
type Subscriber = { handlers: () => RealtimeHandlers; immediateGames: boolean };

/**
 * socket.io-client 4.8.1 creates a new Manager when '/' is already cached.
 * Calling io(API_BASE) in every hook therefore never shared a connection.
 * This owner ref-counts every user/admin subscriber onto one real socket.
 */
export function createRealtimeClient(url: string, getToken: () => Promise<string | null>) {
  let socket: Socket | null = null;
  let state = INITIAL_REALTIME;
  let refs = 0;
  let generation = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const subscribers = new Set<Subscriber>();
  const observers = new Set<() => void>();
  const bindings = new Map<string, (payload: unknown) => void>();
  const publish = (next: Partial<RealtimeState>) => {
    const merged = { ...state, ...next };
    if (Object.keys(merged).every((key) => merged[key as keyof RealtimeState] === state[key as keyof RealtimeState])) return;
    state = merged; for (const observer of observers) observer();
  };
  const dispatch = (event: string, payload: unknown, immediateGames = false) => {
    for (const subscriber of subscribers) {
      if (event === "games:changed" && subscriber.immediateGames !== immediateGames) continue;
      subscriber.handlers()[event]?.(payload);
    }
  };
  const refresh = createGamesRefresh((value) => dispatch("games:changed", value), (bulk) => publish({ bulk }));
  const clearRetry = () => { clearTimeout(retryTimer); retryTimer = undefined; };
  const retry = () => {
    if (!socket || socket.connected || retryTimer !== undefined || !refs) return;
    const attempts = state.attempts + 1;
    publish({ status: navigator.onLine === false || attempts >= 6 ? "offline" : "reconnecting", attempts });
    retryTimer = setTimeout(() => { retryTimer = undefined; socket?.connect(); }, Math.min(30000, 1000 * 2 ** Math.min(attempts - 1, 5)));
  };
  const online = () => { if (!socket || socket.connected) return; clearRetry(); publish({ status: "reconnecting" }); socket.connect(); };
  const offline = () => { clearRetry(); publish({ status: "offline" }); };
  const bind = (event: string) => {
    if (!socket || bindings.has(event) || ["connect", "disconnect", "connect_error"].includes(event)) return;
    const handler = (payload: unknown) => {
      if (!refs) return;
      if (event === "games:changed") {
        const value = gamesChanged(payload); dispatch(event, value, true); refresh.receive(value);
      } else dispatch(event, payload);
    };
    bindings.set(event, handler); socket.on(event, handler);
  };
  const start = () => {
    if (socket) return;
    const ownGeneration = ++generation;
    publish({ status: navigator.onLine === false ? "offline" : "connecting", attempts: 0 });
    const created = io(url, {
      auth: async (done) => {
        try { const token = await getToken(); if (generation === ownGeneration && refs) done(token ? { token } : {}); }
        catch { if (generation === ownGeneration && refs) done({}); }
      },
      transports: ["websocket", "polling"], reconnection: true,
      reconnectionAttempts: Infinity, reconnectionDelay: 500, reconnectionDelayMax: 5000,
    });
    socket = created;
    created.on("connect", () => {
      if (socket !== created || !refs) return;
      clearRetry(); publish({ status: "connected", attempts: 0, lastConnectedAt: Date.now() }); dispatch("connect", undefined);
    });
    created.on("disconnect", (reason) => {
      if (socket !== created || !refs) return;
      publish({ status: navigator.onLine === false ? "offline" : "reconnecting" });
      dispatch("disconnect", reason); retry();
    });
    created.on("connect_error", (error) => { if (socket === created && refs) { dispatch("connect_error", error); retry(); } });
    for (const subscriber of subscribers) for (const event of Object.keys(subscriber.handlers())) bind(event);
    window.addEventListener("online", online); window.addEventListener("offline", offline);
  };
  const stop = () => {
    clearRetry(); refresh.dispose(); bindings.clear();
    window.removeEventListener("online", online); window.removeEventListener("offline", offline);
    const previous = socket; socket = null;
    generation += 1;
    previous?.off?.(); previous?.disconnect();
    state = INITIAL_REALTIME;
  };
  const retain = () => { clearTimeout(closeTimer); refs += 1; start(); };
  const release = () => {
    refs = Math.max(0, refs - 1);
    // StrictMode's effect probe resubscribes in this tick. It keeps the
    // same connection; a real unmount closes it after all listeners leave.
    if (!refs) closeTimer = setTimeout(() => { if (!refs) stop(); }, 0);
  };
  return {
    subscribe(handlers: () => RealtimeHandlers, immediateGames = false) {
      const subscriber = { handlers, immediateGames }; subscribers.add(subscriber); retain();
      for (const event of Object.keys(handlers())) bind(event);
      return () => { subscribers.delete(subscriber); release(); };
    },
    observe(listener: () => void) { observers.add(listener); retain(); return () => { observers.delete(listener); release(); }; },
    snapshot: () => state,
  };
}
export type RealtimeClient = ReturnType<typeof createRealtimeClient>;
