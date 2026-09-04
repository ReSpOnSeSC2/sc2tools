"use client";

import Link from "next/link";
import { useReleaseInfo } from "@/components/onboarding/useReleaseInfo";
import {
  FALLBACK_LATEST_AGENT_VERSION,
  inactiveAgentMessage,
} from "@/lib/agentNotice";
import { useApi } from "@/lib/clientApi";

type DoctorResp = {
  ok: boolean;
  warnings?: {
    id: string;
    severity: "info" | "warn" | "error";
    message: string;
    cta?: { label: string; href: string };
  }[];
};

/**
 * "Doctor" banner — a top-of-page warning strip when something is off
 * (no agent connected, schema migration pending, ML model stale, etc).
 * The API computes warnings; the UI just renders them.
 */
export function DoctorBanner() {
  // A full re-sync can begin while this page is open. Poll lightly so the
  // one-time notice disappears after the latest agent acknowledges that the
  // all-time scan started, without requiring a dashboard refresh.
  const { data } = useApi<DoctorResp>("/v1/me/doctor", {
    refreshInterval: (latest) =>
      latest?.warnings?.some(
        (warning) => warning.id === "replay_archive_incomplete",
      )
        ? 30_000
        : 0,
  });
  const warnings = (data?.warnings || []).filter(
    (w) => w.severity !== "info",
  );
  if (!warnings.length) return null;

  return (
    <ul className="space-y-2" aria-live="polite">
      {warnings.map((w) => {
        const cls =
          w.severity === "error"
            ? "border-danger/40 bg-danger/10 text-danger"
            : "border-warning/40 bg-warning/10 text-warning";
        return (
          <li
            key={w.id}
            className={`flex items-center justify-between gap-3 rounded border px-4 py-2 text-sm ${cls}`}
          >
            <DoctorMessage warning={w} />
            {w.cta && (
              <Link
                href={w.cta.href}
                className="hard-press inline-flex shrink-0 items-center gap-2 rounded-full border-2 border-line bg-bg-surface px-5 py-[0.55rem] font-display text-xs font-bold text-text hover:bg-bg-elevated"
              >
                {w.cta.label}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function DoctorMessage({
  warning,
}: {
  warning: NonNullable<DoctorResp["warnings"]>[number];
}) {
  if (warning.id !== "no_agent") return <span>{warning.message}</span>;
  return <InactiveAgentMessage />;
}

function InactiveAgentMessage() {
  // The Windows agent runs on the gaming PC, but this responsive warning can
  // be read from either mobile or desktop. Fetch only for this warning so a
  // healthy analyzer does not make an unnecessary release request.
  const release = useReleaseInfo("windows");
  return (
    <span>
      {inactiveAgentMessage(
        release.data?.latest || FALLBACK_LATEST_AGENT_VERSION,
      )}
    </span>
  );
}
