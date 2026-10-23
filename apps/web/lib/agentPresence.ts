/** Heartbeats arrive every 60 s; two missed reports plus grace means offline. */
export const FRESH_HEARTBEAT_MS = 150_000;
export function agentPresence(agentLastSeenAt: string | null | undefined, now: number): "online" | "offline" {
  const time = agentLastSeenAt ? Date.parse(agentLastSeenAt) : Number.NaN;
  return Number.isFinite(time) && now - time < FRESH_HEARTBEAT_MS ? "online" : "offline";
}
