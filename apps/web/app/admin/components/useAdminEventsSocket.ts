"use client";

import { useUserSocket } from "@/lib/useUserSocket";
import type { AdminEvent } from "./adminTypes";

/** The server joins authenticated admins to the admin room on this same
 * user socket. Durable rows are refreshed on each namespace connect because
 * admin events are not replayed, including after transport reconnection.
 */
export function useAdminEventsSocket(
  onEvent: ((event: AdminEvent) => void) | null,
  onConnected: (() => void) | null = null,
): void {
  useUserSocket({
    "admin:event": (payload) => { if (payload && typeof payload === "object") onEvent?.(payload as AdminEvent); },
    connect: () => onConnected?.(),
  });
}
