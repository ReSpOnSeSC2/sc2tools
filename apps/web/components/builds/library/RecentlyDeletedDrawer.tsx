"use client";

import { useState } from "react";
import { Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { fmtAgo, fmtDay } from "@/lib/format";
import type { TrashResponse } from "@/lib/buildLibrary";

/**
 * "Recently deleted": builds deleted in the last 30 days, newest first,
 * each with Restore. Restoring never republishes a Community listing.
 */
export function RecentlyDeletedDrawer({
  open,
  trash,
  loading,
  error,
  onRetry,
  onClose,
  onRestore,
}: {
  open: boolean;
  trash: TrashResponse | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onClose: () => void;
  /** Resolves once the build is back (or the restore failed). */
  onRestore: (slug: string, name: string) => Promise<void>;
}) {
  const [restoring, setRestoring] = useState<string | null>(null);
  const days = trash?.retentionDays ?? 30;
  const items = trash?.items ?? [];

  const restore = async (slug: string, name: string) => {
    setRestoring(slug);
    try {
      await onRestore(slug, name);
    } finally {
      setRestoring(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Recently deleted"
      description={`Deleted builds stay here for ${days} days, then they're removed for good. Restored builds come back private.`}
      desktopLayout="side"
    >
      {error && !trash ? (
        <div role="alert" className="space-y-3 py-6 text-center text-caption text-text-muted">
          <p>Recently deleted builds couldn’t load.</p>
          <Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button>
        </div>
      ) : loading && !trash ? (
        <p role="status" className="py-6 text-caption text-text-muted">Loading…</p>
      ) : items.length === 0 ? (
        <EmptyStatePanel
          size="sm"
          icon={<Trash2 className="h-6 w-6" aria-hidden />}
          title="Nothing deleted recently"
          description={`Builds you delete stay restorable here for ${days} days.`}
        />
      ) : (
        <ul className="space-y-2" aria-label="Deleted builds">
          {items.map((item) => (
            <li key={item.slug} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border-2 border-line bg-bg-surface p-3">
              <div className="min-w-0">
                <p className="break-words font-semibold text-text">{item.name}</p>
                <p className="text-micro text-text-dim">
                  Deleted {fmtAgo(item.deletedAt)} · removed for good {fmtDay(item.purgeAt)}
                  {item.perspective === "opponent" ? " · opponent capture" : ""}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                loading={restoring === item.slug}
                disabled={restoring !== null}
                iconLeft={<Undo2 className="h-4 w-4" aria-hidden />}
                onClick={() => void restore(item.slug, item.name)}
                aria-label={`Restore ${item.name}`}
              >
                Restore
              </Button>
            </li>
          ))}
          {trash && trash.total > items.length ? (
            <li className="text-center text-micro text-text-dim">Showing the newest {items.length} of {trash.total}.</li>
          ) : null}
        </ul>
      )}
    </Modal>
  );
}
