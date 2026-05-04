"use client";

import { useApi } from "@/lib/clientApi";
import Link from "next/link";

type DoctorResp = {
  ok: boolean;
  warnings?: { id: string; severity: "info" | "warn" | "error"; message: string; cta?: { label: string; href: string } }[];
};

/**
 * "Doctor" banner — a top-of-page warning strip when something is off
 * (no agent connected, schema migration pending, ML model stale, etc).
 * The API computes warnings; the UI just renders them.
 */
export function DoctorBanner() {
  const { data } = useApi<DoctorResp>("/v1/me/doctor");
  const warnings = (data?.warnings || []).filter(
    (w) => w.severity !== "info",
  );
  if (!warnings.length) return null;

  return (
    <ul className="space-y-2">
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
              <Link href={w.cta.href} className="btn btn-secondary text-xs">
                {w.cta.label}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
