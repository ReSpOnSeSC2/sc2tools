"use client";

import { useEffect, useId } from "react";
import { useLinkStatus } from "next/link";
import { Loader2 } from "lucide-react";
import { useGuideFilterPending } from "./GuideFilterPending";

export function FilterPillLabel({ label }: { label: string }) {
  const { pending } = useLinkStatus();
  const { report } = useGuideFilterPending();
  const id = useId();
  useEffect(() => { report(id, pending ? label : null); return () => report(id, null); }, [id, label, pending, report]);
  return <span className="inline-flex items-center gap-1" data-pending={pending || undefined}>
    {pending ? <Loader2 aria-hidden className="h-3.5 w-3.5 motion-safe:animate-spin" /> : null}{label}
  </span>;
}
