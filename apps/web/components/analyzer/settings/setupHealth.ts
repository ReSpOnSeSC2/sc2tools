import { AGENT_ONLINE_WINDOW_MS, isAgentVersionAtLeast } from "@/components/dashboard/AgentUpgradeNotice";
import { fmtAgo } from "@/lib/format";
import type { DoctorResp } from "../DoctorBanner";

export type SetupMe = {
  userId: string;
  agentPaired?: boolean;
  agentVersion?: string | null;
  agentLastSeenAt?: string | null;
  games?: { total: number; latest?: string | null };
  onboarding?: { goals?: string[] } | null;
};
export type SetupSource<T> = { data?: T; error?: unknown; mutate: () => unknown };
export type SetupRow = { id: string; title: string; message: string; tone: "pass" | "warn" | "info" | "loading"; cta?: { label: string; href: string }; retry?: () => unknown };
type OverlayStatus = { items: { revokedAt?: string | null; lastSeenAt?: string | null }[] };
type Sources = { me: SetupSource<SetupMe>; doctor: SetupSource<DoctorResp>; release: SetupSource<{ latest?: string }>; overlays: SetupSource<OverlayStatus>; now: number };

function unavailable<T>(source: SetupSource<T>, id: string, title: string): SetupRow | null {
  if (source.error) return { id, title, tone: "warn", message: "Couldn't check", retry: source.mutate };
  if (!source.data) return { id, title, tone: "loading", message: "Checking…" };
  return null;
}

export function setupAgentOnline(me: SetupMe, now: number) {
  const age = me.agentLastSeenAt ? now - Date.parse(me.agentLastSeenAt) : NaN;
  return Boolean(me.agentPaired && age >= 0 && age < AGENT_ONLINE_WINDOW_MS);
}

function identityRow(doctor: Sources["doctor"]): SetupRow {
  const missing = unavailable(doctor, "identity", "SC2 identity"); if (missing) return missing;
  const warning = doctor.data?.warnings?.find((item) => item.id === "no_profile");
  return { id: "identity", title: "SC2 identity", tone: warning ? "warn" : "pass", message: warning ? "Set up your SC2 profile" : "Profile is set up", cta: warning ? { label: "Set up profile", href: "/settings?tab=profile" } : undefined };
}

function desktopRow(me: Sources["me"], now: number): SetupRow {
  const missing = unavailable(me, "desktop", "Desktop app"); if (missing) return missing;
  const value = me.data!;
  const online = setupAgentOnline(value, now);
  const seen = value.agentLastSeenAt ? fmtAgo(value.agentLastSeenAt) : "not seen yet";
  return { id: "desktop", title: "Desktop app", tone: online ? "pass" : "warn", message: online ? `Online · seen ${seen}` : value.agentPaired ? `Paired${value.agentLastSeenAt ? `, last seen ${seen}` : " — waiting for a first connection"}: open SC2 Tools on your PC` : "Not paired", cta: online ? undefined : { label: value.agentPaired ? "Manage PCs" : "Pair a PC", href: "/devices" } };
}

function versionRow(me: Sources["me"], release: Sources["release"]): SetupRow {
  const missing = unavailable(me, "version", "Up to date"); if (missing) return missing;
  if (!me.data?.agentPaired) return { id: "version", title: "Up to date", message: "Pair a PC to check its version", tone: "info" };
  const pending = unavailable(release, "version", "Up to date");
  if (pending) return { ...pending, message: release.error ? "Couldn't check for updates" : pending.message };
  const version = me.data.agentVersion;
  if (!version || !release.data?.latest) return { id: "version", title: "Up to date", message: "Version not reported yet", tone: "info", cta: { label: "Check downloads", href: "/download" } };
  const current = isAgentVersionAtLeast(version, release.data.latest);
  return { id: "version", title: "Up to date", message: current ? `v${version} · up to date` : `v${version} · Update available → v${release.data.latest}`, tone: current ? "pass" : "warn", cta: current ? undefined : { label: "Update", href: "/download" } };
}

function gamesRow(me: Sources["me"], doctor: Sources["doctor"]): SetupRow {
  const missing = unavailable(me, "games", "Games synced"); if (missing) return missing;
  const games = me.data?.games;
  const warning = doctor.data?.warnings?.find((item) => item.id === "no_games");
  const total = games?.total ?? 0;
  return { id: "games", title: "Games synced", message: `${total.toLocaleString()} games${games?.latest ? ` · latest game ${fmtAgo(games.latest)}` : ""}`, tone: total > 0 && !warning ? "pass" : "warn", cta: total > 0 && !warning ? undefined : warning?.cta || { label: "Import games", href: "/settings?tab=import" } };
}

function overlayRow(overlays: Sources["overlays"]): SetupRow {
  const missing = unavailable(overlays, "overlay", "Overlay"); if (missing) return missing;
  const seen = overlays.data?.items.filter((item) => !item.revokedAt && item.lastSeenAt).map((item) => item.lastSeenAt!).sort().at(-1);
  return { id: "overlay", title: "Overlay", message: seen ? `Overlay seen ${fmtAgo(seen)}` : "Optional: not set up", tone: seen ? "pass" : "info", cta: seen ? undefined : { label: "Set up overlay", href: "/settings?tab=overlay" } };
}

/** Each independently failing source affects only the rows that require it. */
export function setupHealthRows({ me, doctor, release, overlays, now }: Sources): SetupRow[] {
  const rows = [identityRow(doctor), desktopRow(me, now), versionRow(me, release), gamesRow(me, doctor)];
  if (!me.data?.onboarding?.goals || me.data.onboarding.goals.includes("stream")) rows.push(overlayRow(overlays));
  const archive = unavailable(doctor, "archive", "Replay archive");
  const warning = doctor.data?.warnings?.find((item) => item.id === "replay_archive_incomplete");
  rows.push(archive || { id: "archive", title: "Replay archive", message: warning?.message || "No replay archive warnings", tone: warning ? "warn" : "pass", cta: warning?.cta });
  const known = new Set(["no_profile", "no_agent", "no_games", "replay_archive_incomplete"]);
  for (const item of doctor.data?.warnings || []) if (!known.has(item.id)) rows.push({ id: item.id, title: "Setup check", message: item.message, tone: item.severity === "info" ? "info" : "warn", cta: item.cta });
  return rows;
}
