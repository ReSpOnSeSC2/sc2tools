"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Trash2 } from "lucide-react";
import { forgetDeviceCopy } from "@/lib/analysisCorpus/deviceClear";
import { deviceNote } from "@/lib/analysisCorpus/deviceNote";
import type { DeviceSummary } from "@/lib/analysisCorpus/deviceStore";
import { defaultIndexedDb } from "@/lib/instant/idb";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { useToast } from "@/components/ui/Toast";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";

type Row = { kind: "checking" } | { kind: "none" } | { kind: "blocked" } | Exclude<DeviceSummary, { kind: "absent" }>;

/**
 * Settings > Backups & data: how many games this browser keeps for the signed-in account, roughly how much space they
 * take, and Clear. It loads the device store and opens IndexedDB only when the device note names this account, never
 * creates the database, and clearing never deletes anything from the account. `revision` re-reads the row after a
 * wipe or restore on this page.
 *
 * Example:
 *   <DeviceHistorySection revision={deviceRevision} />
 */
export function DeviceHistorySection({ revision }: { revision: number }) {
  const { isLoaded, userId } = useAuth();
  const { toast } = useToast();
  const owner = userId ?? null;
  // Each row is read for one account, so another account's row never shows, even for a render.
  const [read, setRead] = useState<{ owner: string | null; row: Row } | null>(null);
  const row: Row = read && read.owner === owner ? read.row : { kind: "checking" };
  const status = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!isLoaded) return;
    let cancelled = false;
    void readRow(owner).then((next) => {
      // A clear, or another account's keep, while reading leaves nothing of this account's to show.
      if (!cancelled) setRead({ owner, row: next.kind === "none" || next.kind === "blocked" || deviceNote() === owner ? next : { kind: "none" } });
    });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, owner, revision]);

  const clear = () => {
    forgetDeviceCopy();
    setRead({ owner, row: { kind: "none" } });
    toast.success("Cleared from this device", { description: "Your games are still in your account." });
    // Clear goes away with the copy; the row that says so takes focus.
    status.current?.focus();
  };
  const canClear = row.kind === "stored" || row.kind === "kept" || row.kind === "unreadable";

  return (
    <Section
      id="device-history"
      className="scroll-mt-28"
      title="Games on this device"
      description="Daily Pulse can keep a copy of your game history in this browser. Season Recap and Arcade use the same copy. Clearing it never deletes anything from your account."
    >
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p
            ref={status}
            tabIndex={-1}
            role="status"
            className="min-w-0 flex-1 basis-56 rounded text-body-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {rowText(row)}
          </p>
          {canClear ? (
            <Button
              variant="secondary"
              onClick={clear}
              aria-label="Clear games stored on this device"
              iconLeft={<Trash2 className="h-4 w-4" aria-hidden />}
            >
              Clear
            </Button>
          ) : null}
        </div>
        <p className="mt-2 text-caption">
          <LazyHelpLink slug="history-on-this-device" className="inline-flex min-h-11 items-center">
            Your history on this device
          </LazyHelpLink>
        </p>
      </Card>
    </Section>
  );
}

async function readRow(userId: string | null): Promise<Row> {
  const noted = deviceNote();
  const factory = defaultIndexedDb();
  if (noted === undefined || !factory) return { kind: "blocked" };
  if (!userId || noted !== userId) return { kind: "none" };
  try {
    const { openDeviceCorpus, readDeviceSummary } = await import("@/lib/analysisCorpus/deviceStore");
    let absent = false;
    const db = await openDeviceCorpus(factory, { create: false, onAbsent: () => { absent = true; } });
    if (!db) return absent ? { kind: "none" } : { kind: "unreadable" };
    try {
      const summary = await readDeviceSummary(db, userId);
      return summary.kind === "absent" ? { kind: "none" } : summary;
    } finally {
      db.close();
    }
  } catch {
    return { kind: "unreadable" };
  }
}

function rowText(row: Row): string {
  switch (row.kind) {
    case "checking":
      return "Checking this device…";
    case "stored":
      return `Games stored on this device: ${row.count.toLocaleString()} (${sizeText(row.bytes)})`;
    case "kept":
      return "Your history is set to be kept here, but no games are stored. Accounts with more than 20,000 games aren’t kept.";
    case "none":
      return "No games are stored on this device.";
    case "blocked":
      return "This browser isn’t letting us store data, so no games are kept here.";
    case "unreadable":
      return "Couldn’t check this device.";
  }
}

function sizeText(bytes: number): string {
  const megabytes = bytes / 1024 / 1024;
  return megabytes < 0.1 ? "under 0.1 MB" : `about ${megabytes.toFixed(1)} MB`;
}
