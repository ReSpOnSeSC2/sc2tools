"use client";

import { useRealtimeEvents } from "@/components/realtime/RealtimeProvider";

/** Subscribe to the shared Clerk-authenticated socket, or a local fallback.
 * Handlers may change identity; only adding/removing event names rebinds.
 * games:changed refreshes are coalesced centrally; live counters use the
 * provider's immediate-games subscription instead. Pass null to opt out.
 */
export function useUserSocket(handlers: Record<string, (payload: unknown) => void> | null): void {
  useRealtimeEvents(handlers);
}
