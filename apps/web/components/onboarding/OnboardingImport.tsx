"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { History, Play } from "lucide-react";
import { apiCall, type ClientApiError } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { ImportProgressCard } from "@/components/imports/ImportProgressCard";
import { useImportStatus } from "@/components/imports/useImportStatus";
import { BrowserImportPanel } from "@/components/instant/BrowserImportPanel";

/** How the replays reach the account: the paired agent, or this browser. */
export type OnboardingImportMode = "agent" | "browser";

/**
 * Step 4 — Import. The magic moment: the user's existing replay history
 * lands before the dashboard opens, so it opens populated instead of
 * empty. In "agent" mode one click asks the freshly-paired agent to
 * import; in "browser" mode (chosen on the Download step, behind the
 * Instant Analysis flag) replays are analyzed in this tab and the results
 * uploaded — plus a private copy of each replay file when the panel's
 * backup box is ticked (it starts ticked when backups are available).
 * Skipping is fine either way.
 */
export function OnboardingImport({ mode = "agent" }: { mode?: OnboardingImportMode }) {
  return mode === "browser" ? <BrowserModeImport /> : <AgentModeImport />;
}

/** Browser mode: the compact import panel, then the dashboard. */
function BrowserModeImport() {
  const router = useRouter();
  const [imported, setImported] = useState(false);
  return (
    <section aria-labelledby="onboarding-step-heading" className="space-y-8">
      <header className="space-y-2">
        <h1
          id="onboarding-step-heading"
          tabIndex={-1}
          className="text-display-lg font-semibold tracking-tight text-text outline-none"
        >
          Import your replays
        </h1>
        <p className="text-body-lg text-text-muted">
          Choose replays from your StarCraft II folder — they&apos;re analyzed
          right here in your browser, then the results are uploaded to your
          account (plus a private copy of each replay file if the backup box
          below is ticked).
        </p>
      </header>

      <BrowserImportPanel
        compact
        onDone={(summary) =>
          setImported(summary.uploaded + summary.skippedExisting > 0)
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <Button
          variant={imported ? "primary" : "secondary"}
          size="lg"
          onClick={() => router.push("/app")}
        >
          Open your dashboard →
        </Button>
      </div>
    </section>
  );
}

function AgentModeImport() {
  const router = useRouter();
  const { getToken } = useAuth();
  const importStatus = useImportStatus();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startImport() {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      await apiCall(getToken, "/v1/import/start", {
        method: "POST",
        body: "{}",
      });
      importStatus.refresh();
    } catch (err) {
      const e = err as ClientApiError;
      if (e.code === "import_already_running") {
        // The agent's own auto-backfill beat the button — perfect,
        // just show its progress.
        importStatus.refresh();
      } else {
        setError(e.message || "Couldn't start the import.");
      }
    } finally {
      setStarting(false);
    }
  }

  const showProgress = !!importStatus.job &&
    (importStatus.active || importStatus.job.status === "done");

  return (
    <section aria-labelledby="onboarding-step-heading" className="space-y-8">
      <header className="space-y-2">
        <h1
          id="onboarding-step-heading"
          tabIndex={-1}
          className="text-display-lg font-semibold tracking-tight text-text outline-none"
        >
          Import your history
        </h1>
        <p className="text-body-lg text-text-muted">
          Your agent can parse every replay already on this PC — opponents,
          builds, and trends light up from games you&apos;ve already played.
        </p>
      </header>

      {showProgress && importStatus.job ? (
        <div className="rounded-2xl border border-border bg-bg-surface p-5">
          <ImportProgressCard
            job={importStatus.job}
            active={importStatus.active}
            pct={importStatus.pct}
            etaSeconds={importStatus.etaSeconds}
            onCancelled={importStatus.refresh}
          />
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-accent-cyan/30 bg-bg-surface px-6 py-10 text-center shadow-halo-cyan">
          <History className="h-8 w-8 text-accent-cyan" aria-hidden />
          <p className="max-w-md text-body text-text-muted">
            One click — the agent walks your replay folders locally and
            uploads the results. Big libraries take a few minutes; you can
            watch it land on the dashboard.
          </p>
          <Button
            size="lg"
            onClick={() => void startImport()}
            loading={starting}
            disabled={starting}
          >
            Import my replay history
          </Button>
          {error ? (
            <p className="text-caption text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <Button
          variant={showProgress ? "primary" : "ghost"}
          size="lg"
          onClick={() => router.push("/app")}
          iconLeft={
            showProgress ? undefined : <Play className="h-4 w-4" aria-hidden />
          }
        >
          {showProgress
            ? "Open your dashboard →"
            : "Skip — I'll just play a game"}
        </Button>
      </div>
    </section>
  );
}
