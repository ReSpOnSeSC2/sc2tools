"use client";
import { useAuth } from "@clerk/nextjs";
import { useApi } from "@/lib/clientApi";
import type { DoctorResp } from "@/components/analyzer/DoctorBanner";
import { isAgentVersionAtLeast } from "@/components/dashboard/AgentUpgradeNotice";
import { useReleaseInfo } from "./useReleaseInfo";

export function ResyncNotice() {
  const { isLoaded, isSignedIn } = useAuth();
  const doctor = useApi<DoctorResp>(isLoaded && isSignedIn ? "/v1/me/doctor" : null);
  if (!isLoaded || !isSignedIn || doctor.error || !doctor.data?.warnings?.some((warning) => warning.id === "replay_archive_incomplete")) return null;
  return <div role="note" className="max-w-2xl rounded-md border border-accent/35 bg-accent/10 px-4 py-3 text-body text-text">
    <strong>Already using the agent?</strong> Install the latest version, choose <strong>All time</strong> for the replay filter, then click <strong>Re-sync replay library</strong> once. That one scan rebuilds cloud analysis and archives every original still available on this PC; it does not duplicate games.
  </div>;
}
export function InstalledAgentVersion() {
  const { isLoaded, isSignedIn } = useAuth();
  const me = useApi<{ agentPaired?: boolean; agentVersion?: string | null }>(isLoaded && isSignedIn ? "/v1/me" : null);
  const release = useReleaseInfo("windows");
  const current = me.data?.agentVersion?.trim().replace(/^v/, "");
  const latest = release.data?.latest?.trim().replace(/^v/, "");
  if (!isLoaded || !isSignedIn || me.error || release.error || !me.data?.agentPaired || !current || !latest || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(current) || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(latest)) return null;
  return <p className="text-caption text-text-muted">{isAgentVersionAtLeast(current, latest) ? `You're up to date (v${current})` : `Your PC runs v${current}. Update available: v${latest}`}</p>;
}
