"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { History, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { useApi } from "@/lib/clientApi";
import { fmtAgo } from "@/lib/format";
import { buildPath, restoreBuildRevision, type RevisionsResponse } from "@/lib/buildLibrary";
import { RulesDiff } from "./RulesDiff";

/**
 * BuildDetailView's "History" sheet: the build's last 20 saved versions,
 * newest first, each with a rules diff against the current build and
 * "Restore this version" (a normal save, so the current version joins the
 * history and the restore can itself be undone).
 */
export function BuildHistorySheet({
  open,
  slug,
  current,
  onClose,
  onRestored,
}: {
  open: boolean;
  slug: string;
  /** The build as it is now, for the comparison. */
  current: object;
  onClose: () => void;
  onRestored: () => void;
}) {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const history = useApi<RevisionsResponse>(open ? buildPath(slug, "/revisions") : null, { revalidateOnFocus: false });
  const [expanded, setExpanded] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const items = history.data?.items ?? [];

  const restore = async (rev: number, savedAt: string) => {
    setRestoring(rev);
    try {
      await restoreBuildRevision(getToken, slug, rev);
      toast.success(`Restored the version from ${fmtAgo(savedAt)}`, {
        description: "The version you replaced is now in History.",
      });
      onRestored();
      void history.mutate();
      setExpanded(null);
    } catch (err) {
      toast.error("Couldn’t restore that version", {
        description: err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : undefined,
      });
    } finally {
      setRestoring(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="History" description="Earlier versions of this build. Restoring one keeps the current version here too." desktopLayout="side" size="lg">
      {history.error ? (
        <div role="alert" className="space-y-3 py-6 text-center text-caption text-text-muted">
          <p>History couldn’t load.</p>
          <Button variant="secondary" size="sm" onClick={() => void history.mutate()}>Try again</Button>
        </div>
      ) : !history.data ? (
        <p role="status" className="py-6 text-caption text-text-muted">Loading history…</p>
      ) : items.length === 0 ? (
        <EmptyStatePanel
          size="sm"
          icon={<History className="h-6 w-6" aria-hidden />}
          title="No earlier versions yet"
          description="Each time you save a change, the version it replaces is kept here (the last 20)."
        />
      ) : (
        <ol className="space-y-3" aria-label="Saved versions, newest first">
          {items.map((item) => {
            const panelId = `history-${slug}-${item.rev}`;
            const isOpen = expanded === item.rev;
            return (
              <li key={item.rev} className="rounded-xl border-2 border-line bg-bg-surface p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-text">{String(item.build.name || "Untitled build")}</p>
                    <p className="text-micro text-text-dim" title={new Date(item.savedAt).toLocaleString()}>
                      Replaced {fmtAgo(item.savedAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="ghost" size="sm" aria-expanded={isOpen} aria-controls={panelId} onClick={() => setExpanded(isOpen ? null : item.rev)}>
                      {isOpen ? "Hide changes" : "Compare"}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={restoring === item.rev}
                      disabled={restoring !== null}
                      iconLeft={<RotateCcw className="h-4 w-4" aria-hidden />}
                      onClick={() => void restore(item.rev, item.savedAt)}
                    >
                      Restore this version
                    </Button>
                  </div>
                </div>
                {isOpen ? (
                  <div id={panelId} className="mt-3">
                    <RulesDiff from={current} to={item.build} fromLabel="Current" toLabel="This version" />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </Modal>
  );
}
