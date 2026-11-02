"use client";

import { LinkButton } from "@/components/ui/Button";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { useReleaseInfo } from "@/components/onboarding/useReleaseInfo";
import {
  FALLBACK_LATEST_AGENT_VERSION,
  inactiveAgentMessage,
} from "@/lib/agentNotice";
import { useApi } from "@/lib/clientApi";
import { doctorHelp } from "@/lib/syncHealth";

export type DoctorResp = {
  ok: boolean;
  warnings?: {
    id: string;
    severity: "info" | "warn" | "error";
    message: string;
    cta?: { label: string; href: string };
    /** A help article for this warning; the Sync health ids (roadmap item 76) send one. */
    helpSlug?: string;
  }[];
};

/**
 * "Doctor" banner — a top-of-page warning strip when something is off
 * (no agent connected, replay archive incomplete, and similar checks).
 * The API computes warnings; the UI just renders them.
 */
export function DoctorBanner() {
  const { data } = useDoctor();
  const warnings = (data?.warnings || []).filter((w) => w.severity !== "info");
  if (!warnings.length) return null;

  return <ul className="space-y-2" aria-live="polite">{warnings.map((w) => <DoctorWarning key={w.id} warning={w} />)}</ul>;
}

/** Shared SWR key for the dashboard warning and Settings setup overview. */
export function useDoctor() {
  // A full re-sync can begin while this page is open. Poll lightly so the
  // one-time notice disappears after the latest agent acknowledges that the
  // all-time scan started, without requiring a dashboard refresh.
  return useApi<DoctorResp>("/v1/me/doctor", {
    refreshInterval: (latest) =>
      latest?.warnings?.some(
        (warning) => warning.id === "replay_archive_incomplete",
      )
        ? 30_000
        : 0,
  });
}

function DoctorWarning({ warning: w }: { warning: NonNullable<DoctorResp["warnings"]>[number] }) {
  const cls =
    w.severity === "error"
      ? "border-danger/40 bg-danger/10 text-danger"
      : "border-warning/40 bg-warning/10 text-warning";
  // A Sync health id lands on its own section of the help article; another
  // warning may name an article of its own.
  const help = doctorHelp(w);
  return (
    <li
      className={`flex items-center justify-between gap-3 rounded border px-4 py-2 text-sm ${cls}`}
    >
      {help ? (
        <span className="min-w-0">
          <DoctorMessage warning={w} />{" "}
          <LazyHelpLink slug={help.slug} anchor={help.anchor} className="whitespace-nowrap">
            How to fix{help.title ? <span className="sr-only"> {help.title.toLowerCase()}</span> : null}
          </LazyHelpLink>
        </span>
      ) : (
        <DoctorMessage warning={w} />
      )}
      {w.cta && (
        <LinkButton href={w.cta.href} variant="secondary" size="sm" className="shrink-0">
          {w.cta.label}
        </LinkButton>
      )}
    </li>
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
