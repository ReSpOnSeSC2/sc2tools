import { io, type Socket } from "socket.io-client";
import { isChatEventKind, type ChatEvent } from "./events";
import type { ChatEngine, ChatPlatform } from "./types";

const PLATFORMS = new Set<ChatPlatform>([
  "twitch",
  "kick",
  "youtube",
  "tiktok",
]);

/** Validate the signed server event before it enters any alert/audio surface. */
export function parseOfficialPlatformEvent(value: unknown): ChatEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const platform = raw.platform as ChatPlatform;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const user = typeof raw.user === "string" ? raw.user.trim() : "";
  const detail = typeof raw.detail === "string" ? raw.detail.trim() : "";
  const atMs = Number(raw.atMs);
  const receivedAtMs = Number(raw.receivedAtMs);
  if (
    !PLATFORMS.has(platform)
    || !id
    || id.length > 240
    || !isChatEventKind(raw.kind)
    || !user
    || !Number.isFinite(atMs)
  ) return null;
  return {
    platform,
    id,
    kind: raw.kind,
    user: user.slice(0, 120),
    detail: detail.slice(0, 300),
    ...(typeof raw.amount === "string" && raw.amount
      ? { amount: raw.amount.slice(0, 100) }
      : {}),
    atMs: Math.trunc(atMs),
    ...(Number.isFinite(receivedAtMs) && receivedAtMs > 0
      ? { receivedAtMs: Math.trunc(receivedAtMs) }
      : {}),
    // This parser is fed only by the authenticated server replay/live socket.
    // Defaulting here keeps origin-aware coalescing safe across API upgrades.
    official: true,
    ...(raw.replayed === true ? { replayed: true } : {}),
    ...(typeof raw.updateKey === "string" && raw.updateKey
      ? { updateKey: raw.updateKey.slice(0, 240) }
      : {}),
    ...(Number.isFinite(Number(raw.updateVersion))
      ? { updateVersion: Math.max(0, Math.trunc(Number(raw.updateVersion))) }
      : {}),
    ...(typeof raw.dedupeKey === "string" && raw.dedupeKey
      ? { dedupeKey: raw.dedupeKey.slice(0, 240) }
      : {}),
    ...(Number.isFinite(Number(raw.dedupeWindowMs))
      ? {
        dedupeWindowMs: Math.max(
          0,
          Math.min(10 * 60 * 1000, Math.trunc(Number(raw.dedupeWindowMs))),
        ),
      }
      : {}),
  };
}

/**
 * Official OAuth notifications share the overlay's existing Socket.io trust
 * boundary. This engine reports only events; direct chat engines retain their
 * own connection-status dots.
 */
export function createOfficialPlatformEvents(args: {
  apiBase: string;
  token: string;
  onEvent(event: ChatEvent): void;
  socketFactory?: typeof io;
}): ChatEngine {
  const makeSocket = args.socketFactory || io;
  const socket: Socket = makeSocket(args.apiBase, {
    auth: { overlayToken: args.token },
    transports: ["websocket", "polling"],
    reconnection: true,
  });
  const onPlatformEvent = (value: unknown) => {
    const event = parseOfficialPlatformEvent(value);
    if (event) args.onEvent(event);
  };
  socket.on("overlay:platformEvent", onPlatformEvent);
  return {
    close() {
      socket.off("overlay:platformEvent", onPlatformEvent);
      socket.disconnect();
    },
  };
}
