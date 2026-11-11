"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import type { ReadinessCheck, ReadinessId } from "@/lib/streamReadiness";

export type CheckListProps = { checks: ReadonlyArray<ReadinessCheck>; retry: (id: ReadinessId) => void };

export function StreamReadinessChecks({ checks, retry }: CheckListProps) {
  return <ul className="grid min-w-0 gap-2 sm:grid-cols-2">
    {checks.map((check) => <li key={check.id} className="min-w-0 space-y-2 rounded-lg border border-border p-3 text-caption">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">{check.title}</span>
        <Badge variant={check.state === "ok" ? "success" : check.state === "warn" ? "warning" : "neutral"} aria-live="polite">{check.message}</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Link href={check.href} className="inline-flex min-h-9 items-center text-accent underline focus-visible:ring-2 focus-visible:ring-accent">{check.fix}</Link>
        {check.state === "error" ? <Button variant="secondary" size="sm" aria-label={`Retry ${check.title.toLowerCase()}`} onClick={() => retry(check.id)}>Retry</Button> : null}
      </div>
    </li>)}
  </ul>;
}
