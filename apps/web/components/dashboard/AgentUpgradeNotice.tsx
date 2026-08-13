"use client";

import Link from "next/link";
import { Download, ShieldAlert } from "lucide-react";
import { useApi } from "@/lib/clientApi";

export const REQUIRED_AGENT_VERSION = "0.15.20";
export const AGENT_ONLINE_WINDOW_MS = 3 * 60 * 1000;
export const AGENT_STATUS_REFRESH_MS = 15_000;

export type AgentDevice = {
  deviceId?: string;
  lastSeenAt?: string | null;
  agentVersion?: string | null;
};

type DevicesResponse = { items?: AgentDevice[] };

export type InitialAgentStatus = {
  paired: boolean;
  version?: string | null;
  lastSeenAt?: string | null;
};

type NoticeState =
  | { kind: "ready" }
  | {
      kind: "checking" | "missing" | "offline" | "unknown" | "outdated";
      title: string;
      message: string;
      action: string;
    };

/**
 * Required agent-version notice backed exclusively by authenticated device
 * heartbeat data. It has no dismiss button or browser persistence: the only
 * successful dismissal condition is a live agent reporting the required
 * version (or newer).
 */
export function AgentUpgradeNotice({
  initialAgent,
}: {
  initialAgent: InitialAgentStatus;
}) {
  const initialState = agentUpgradeNoticeState(
    initialAgent.paired
      ? [{
          agentVersion: initialAgent.version,
          lastSeenAt: initialAgent.lastSeenAt,
        }]
      : [],
    Date.now(),
  );
  const initiallyConfirmed = initialState.kind === "ready";
  const devices = useApi<DevicesResponse>(
    initiallyConfirmed ? null : "/v1/devices",
    {
      refreshInterval: (latest) =>
        agentUpgradeNoticeState(latest?.items, Date.now()).kind === "ready"
          ? 0
          : AGENT_STATUS_REFRESH_MS,
      revalidateOnFocus: true,
    },
  );

  const state = devices.data
    ? agentUpgradeNoticeState(devices.data.items, Date.now())
    : initialState.kind === "ready"
      ? initialState
      : devices.isLoading
        ? checkingState()
        : initialState;

  if (state.kind === "ready") return null;

  return (
    <section
      aria-label="Required agent update"
      aria-live="polite"
      className="rounded-xl border-2 border-warning/50 bg-warning/10 px-4 py-3 shadow-hard"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-warning/40 bg-bg-surface text-warning">
            <ShieldAlert className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-micro font-semibold uppercase tracking-wider text-warning">
              Required · Agent v{REQUIRED_AGENT_VERSION}+
            </p>
            <h2 className="mt-0.5 text-body font-bold text-text">
              {state.title}
            </h2>
            <p className="mt-0.5 text-caption leading-relaxed text-text-muted">
              {state.message}
            </p>
          </div>
        </div>
        <Link
          href="/download"
          className="hard-press inline-flex min-h-[44px] w-full flex-shrink-0 items-center justify-center gap-2 rounded-full border-2 border-line bg-bg-surface px-5 py-2 font-display text-caption font-bold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg sm:w-auto"
        >
          <Download className="h-4 w-4" aria-hidden />
          {state.action}
        </Link>
      </div>
    </section>
  );
}

export function agentUpgradeNoticeState(
  rawDevices: AgentDevice[] | undefined,
  nowMs: number,
): NoticeState {
  if (!Array.isArray(rawDevices)) return checkingState();
  if (rawDevices.length === 0) {
    return {
      kind: "missing",
      title: "Install the required desktop agent update",
      message:
        `Install and pair agent v${REQUIRED_AGENT_VERSION} or newer to keep replay syncing reliable.`,
      action: "Download agent",
    };
  }

  const latest = latestDevice(rawDevices);
  if (!isOnline(latest?.lastSeenAt, nowMs)) {
    return {
      kind: "offline",
      title: "Start or update your desktop agent",
      message:
        `Your paired agent is offline. Open it so SC2 Tools can confirm v${REQUIRED_AGENT_VERSION} or newer.`,
      action: "Download update",
    };
  }

  const version = cleanVersion(latest?.agentVersion);
  if (!version) {
    return {
      kind: "unknown",
      title: "Agent update needs confirmation",
      message:
        `Your connected agent has not reported its version yet. Install v${REQUIRED_AGENT_VERSION} or newer, then leave it running.`,
      action: "Download update",
    };
  }
  if (!isAgentVersionAtLeast(version, REQUIRED_AGENT_VERSION)) {
    return {
      kind: "outdated",
      title: "Update your SC2 Tools Agent",
      message:
        `Connected agent v${version} is out of date. Install v${REQUIRED_AGENT_VERSION} or newer for reliable replay syncing.`,
      action: "Download update",
    };
  }
  return { kind: "ready" };
}

export function isAgentVersionAtLeast(
  candidate: string | null | undefined,
  required: string,
): boolean {
  const actual = parseVersion(candidate);
  const target = parseVersion(required);
  if (!actual || !target) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual.parts[index] !== target.parts[index]) {
      return actual.parts[index] > target.parts[index];
    }
  }
  // A pre-release of the required stable build is not enough. Build metadata
  // is ignored, as SemVer requires.
  if (actual.prerelease && !target.prerelease) return false;
  return true;
}

function checkingState(): NoticeState {
  return {
    kind: "checking",
    title: "Checking your connected agent",
    message:
      `This notice closes automatically after a live agent reports v${REQUIRED_AGENT_VERSION} or newer.`,
    action: "Download update",
  };
}

function latestDevice(devices: AgentDevice[]): AgentDevice | undefined {
  return devices.reduce<AgentDevice | undefined>((latest, device) => {
    if (!latest) return device;
    return timestamp(device.lastSeenAt) > timestamp(latest.lastSeenAt)
      ? device
      : latest;
  }, undefined);
}

function isOnline(lastSeenAt: string | null | undefined, nowMs: number): boolean {
  const seenAt = timestamp(lastSeenAt);
  return seenAt > 0 && nowMs - seenAt >= 0
    && nowMs - seenAt < AGENT_ONLINE_WINDOW_MS;
}

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanVersion(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function parseVersion(value: string | null | undefined): {
  parts: [number, number, number];
  prerelease: boolean;
} | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) return null;
  const parts = match.slice(1, 4).map((part) => Number(part));
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return {
    parts: parts as [number, number, number],
    prerelease: Boolean(match[4]),
  };
}
