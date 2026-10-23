"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { usePendingIntents } from "@/lib/buildIntent";
import { useBuildCheckInLive, useBuildCheckInRevision } from "./BuildCheckInProvider";
import { BuildCheckInQueue } from "./BuildCheckInQueue";

/**
 * Header chip "Build check-ins (N)" — the any-page entry point to the
 * check-in queue, in the CoachingBookingAlert pattern. Hidden when nothing
 * is pending or when check-ins are switched off; the queue dialog stays
 * open after the last game is handled so the player sees the outcome.
 */
export function BuildCheckInAlert({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  // The chip lives in the app chrome, which survives client navigation:
  // any link out of the queue (Open game, Settings, a build) closes it.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);
  const { revision } = useBuildCheckInRevision(false);
  const pending = usePendingIntents(1, revision);
  const data = pending.data;
  const enabled = typeof data?.total === "number" && data.disabled !== true;
  // Realtime only matters while check-ins are on; a disabled account keeps
  // no socket open for this feature.
  useBuildCheckInLive(enabled);

  const total = enabled ? Math.max(0, data?.total ?? 0) : 0;
  const count = total > 99 ? "99+" : String(total);
  const label = `Build check-ins (${total})`;

  return (
    <>
      {total > 0 ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={label}
          title={`${total} game${total === 1 ? "" : "s"} waiting for a build check-in`}
          className={[
            "hard-press relative inline-flex items-center justify-center gap-2 rounded-full",
            "border-2 border-line bg-bg-surface text-text hover:bg-bg-elevated",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
            "h-8 min-w-8 px-2",
          ].join(" ")}
        >
          <ClipboardCheck className="h-4 w-4 text-accent" aria-hidden />
          <span className="hidden font-display text-caption font-bold text-text xl:inline">
            Build check-ins
          </span>
          <span
            aria-hidden
            className="absolute -right-1.5 -top-1.5 grid min-h-5 min-w-5 place-items-center rounded-full border-2 border-bg bg-danger px-1 font-mono text-[10px] font-bold leading-none text-white"
          >
            {count}
          </span>
        </button>
      ) : null}
      <BuildCheckInQueue open={open} onClose={() => setOpen(false)} />
    </>
  );
}
