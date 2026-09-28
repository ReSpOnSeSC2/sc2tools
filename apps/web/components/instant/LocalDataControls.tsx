"use client";

/**
 * LocalDataControls — what /try keeps on this device and how to delete it:
 * a note that analysed games are stored only in this browser and expire
 * after 7 days, and a "Clear local data" button (with a confirmation) that
 * forgets them now. Shows a gentler note when the browser refused storage.
 *
 * Example:
 *   <LocalDataControls persisted={stored.persisted} onCleared={() => setGames([])} />
 */
import { useState } from "react";
import { HardDrive, Trash2 } from "lucide-react";
import { Button, ConfirmDialog } from "@/components/ui";
import { clearTryData } from "@/lib/instant/localStore";

export interface LocalDataControlsProps {
  /** False when this browser would not let us store the games. */
  persisted: boolean;
  /** Called after the stored games were deleted. */
  onCleared: () => void;
  className?: string;
}

type ClearStatus = "idle" | "clearing" | "failed";

/**
 * Local-storage note + "Clear local data".
 *
 * Example:
 *   <LocalDataControls persisted onCleared={reset} />
 */
export function LocalDataControls({ persisted, onCleared, className = "" }: LocalDataControlsProps) {
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState<ClearStatus>("idle");
  const clear = async () => {
    setStatus("clearing");
    try {
      await clearTryData();
    } catch {
      // Storage refused the delete; say so instead of pretending it worked.
      setStatus("failed");
      return;
    }
    setStatus("idle");
    setConfirming(false);
    onCleared();
  };
  return (
    <section
      aria-label="Data stored on this device"
      className={["flex flex-col gap-3 rounded-xl border-2 border-line bg-bg-elevated/60 p-4 sm:flex-row sm:items-center sm:justify-between", className]
        .filter(Boolean)
        .join(" ")}
    >
      <p className="flex min-w-0 items-start gap-2 text-caption text-text-muted">
        <HardDrive className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
        <span>
          {persisted
            ? "These games are stored only in this browser and are deleted automatically after 7 days."
            : "This browser isn't letting us store data, so this report disappears when you close the tab."}
        </span>
      </p>
      {persisted ? (
        <Button variant="secondary" onClick={() => setConfirming(true)} iconLeft={<Trash2 className="h-4 w-4" aria-hidden />}>
          Clear local data
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => void clear()}
        title="Clear local data?"
        description="This deletes the games analysed on this page from this browser. Games you already saved to an account are not affected."
        confirmLabel="Clear local data"
        intent="danger"
        loading={status === "clearing"}
      >
        {status === "failed" ? (
          <p role="alert" className="text-caption text-danger">
            Your browser didn&apos;t let us delete the data. Try clearing this site&apos;s data in your browser settings.
          </p>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}
