import type { OverlayPresence } from "./overlayPresence";
import { CHAT_PLATFORMS, type MultichatConfig } from "./multichat/types";

export type StreamToken = {
  token: string;
  revokedAt?: string | null;
  rotationPending?: boolean;
  lastSeenAt?: string | null;
  enabledWidgets?: readonly string[];
};
export type PairedStreamDevice = { lastSeenAt?: string | null };
export type ReadinessResource<T> = { data: T } | { loading: true } | { error: true };
export type ReadinessId = "device" | "source" | "chat" | "dock";
export type ReadinessCheck = {
  id: ReadinessId;
  title: string;
  href: string;
  fix: string;
  state: "ok" | "warn" | "missing" | "loading" | "error";
  message: string;
};
export type ReadinessInputs = {
  devices: ReadinessResource<readonly PairedStreamDevice[]>;
  tokens: ReadinessResource<StreamToken | null>;
  presence: ReadinessResource<OverlayPresence | null>;
  multichat: ReadinessResource<MultichatConfig>;
};

const CHECKS = {
  device: { title: "Desktop app paired", href: "/devices", fix: "Open Devices" },
  source: { title: "Overlay source connected", href: "/settings?tab=overlay&section=setup", fix: "Open Overlay settings" },
  chat: { title: "Chat platform configured", href: "/settings?tab=chat&section=chat", fix: "Configure chat" },
  dock: { title: "Stream Dock opened", href: "/settings?tab=chat&section=dock", fix: "Open Dock setup" },
} as const;

const check = (id: ReadinessId, state: ReadinessCheck["state"], message: string): ReadinessCheck => ({ id, ...CHECKS[id], state, message });
function fromResource<T>(id: ReadinessId, resource: ReadinessResource<T>, ready: (data: T) => ReadinessCheck): ReadinessCheck {
  if ("error" in resource) return check(id, "error", "Couldn’t check");
  if ("loading" in resource) return check(id, "loading", "Checking…");
  return ready(resource.data);
}
const timestamp = (value?: string | null) => typeof value === "string" ? Date.parse(value) : NaN;
function age(when: number, now: number) {
  const minutes = Math.floor(Math.max(0, now - when) / 60_000);
  if (minutes === 0) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

function desktop(devices: readonly PairedStreamDevice[], now: number) {
  if (!devices.length) return check("device", "missing", "Pair the desktop app");
  const latest = devices.reduce((time, device) => Math.max(time, timestamp(device?.lastSeenAt) || 0), 0);
  if (!latest) return check("device", "warn", "Paired · waiting for first connection");
  return now - latest <= 600_000 ? check("device", "ok", `Seen ${age(latest, now)}`)
    : check("device", "warn", `Paired · last seen ${age(latest, now)}`);
}

/** Learn and Settings derive the same checks from the available owner-scoped reads. */
export function streamReadiness({ devices, tokens, presence, multichat }: ReadinessInputs, now: number): ReadinessCheck[] {
  const source = fromResource("source", presence, (snapshot) => {
    const count = (snapshot?.surfaces["all-in-one"]?.count ?? 0) + (snapshot?.surfaces.widget?.count ?? 0) + (snapshot?.surfaces.scene?.count ?? 0);
    if (count) return check("source", "ok", `${count} connected`);
    return fromResource("source", tokens, (token) => {
      const seen = timestamp(token?.lastSeenAt);
      if (Number.isFinite(seen)) return check("source", "warn", `Last seen ${age(seen, now)}`);
      if (snapshot?.surfaces.unknown?.count) return check("source", "warn", "Unknown source · refresh older Browser Sources");
      return check("source", "missing", "Add an OBS Browser Source");
    });
  });
  const dock = fromResource("dock", presence, (snapshot) => {
    const count = snapshot?.surfaces.dock?.count ?? 0;
    return count ? check("dock", "ok", `${count} connected`) : check("dock", "missing", "Open your Dock");
  });
  const chat = fromResource("chat", multichat, (config) => {
    const count = CHAT_PLATFORMS.filter((platform) => config[platform]?.enabled === true).length;
    return count ? check("chat", "ok", `${count} ${count === 1 ? "platform" : "platforms"} enabled`) : check("chat", "missing", "Connect a chat platform");
  });
  return [fromResource("device", devices, (data) => desktop(data, now)), source, chat, dock];
}

export const AUTOMATIC_LESSONS: Readonly<Partial<Record<ReadinessId, string>>> = {
  device: "pair-your-pc", source: "test-with-purpose", dock: "make-it-yours",
};
