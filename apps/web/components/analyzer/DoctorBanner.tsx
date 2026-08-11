"use client";

import { useApi } from "@/lib/clientApi";
import Link from "next/link";

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
            <span>{w.message}</span>
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
