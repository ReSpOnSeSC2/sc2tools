"use client";

import dynamic from "next/dynamic";
import { Card, Skeleton } from "@/components/ui/Card";

/** The card's shape while its code or its first answer loads. */
export function SyncHealthSkeleton() {
  return <Card title="Sync health" headingLevel={2}><Skeleton rows={2} /></Card>;
}

// The rows, their copy and the report form load in their own chunk, so the
// Account tab's first load grows only by this shell.
const SyncHealthCard = dynamic(
  () => import("./SyncHealthCard").then((mod) => mod.SyncHealthCard),
  { loading: () => <SyncHealthSkeleton /> },
);

/** A static section: Settings search and the section nav can land on it before the body arrives. */
export function SyncHealthSection() {
  return <section id="sync-health" className="scroll-mt-28" aria-label="Sync health"><SyncHealthCard /></section>;
}
