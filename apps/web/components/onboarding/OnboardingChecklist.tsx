"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { Check, Download, Loader2, Play } from "lucide-react";
import { apiCall } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ImportProgressCard } from "@/components/imports/ImportProgressCard";
import { useImportStatus } from "@/components/imports/useImportStatus";

const AGENT_ONLINE_WINDOW_MS = 3 * 60 * 1000;

export type ChecklistMe = {
  games: { total: number };
  agentPaired: boolean;
  agentLastSeenAt?: string | null;
  onboarding?: { downloadStartedAt?: string; dismissedAt?: string } | null;
};

/** Server-derived completion state for the three steps. */
export function checklistVisible(me: ChecklistMe): boolean {
  if (me.onboarding?.dismissedAt) return false;
  return !(me.agentPaired && me.games.total > 0);
}

/**
 * Dashboard onboarding checklist — the in-app continuation of the
 * /welcome wizard. Three rows whose completion is derived from
 * server truth (not client state, so it survives refreshes and other
 * devices): download → pair (with a live agent-online dot and inline
 * pairing code) → import your history or just play a game. Replaces
 * the dead-end NoGamesYet card until the funnel completes.
 */
export function OnboardingChecklist({
  me,
  onRefresh,
}: {
  me: ChecklistMe;
  onRefresh?: () => void;
}) {
  const { getToken } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const importStatus = useImportStatus();
  const [startingImport, setStartingImport] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  if (dismissed || !checklistVisible(me)) return null;

  const downloadDone =
    me.agentPaired || !!me.onboarding?.downloadStartedAt;
  const pairDone = me.agentPaired;
  const playDone = me.games.total > 0;
  const agentOnline =
    !!me.agentLastSeenAt &&
    Date.now() - new Date(me.agentLastSeenAt).getTime() <
      AGENT_ONLINE_WINDOW_MS;

  async function markDownloadStarted() {
    try {
      await apiCall(getToken, "/v1/me/preferences/onboarding", {
        method: "PUT",
        body: JSON.stringify({
          ...(me.onboarding || {}),
          downloadStartedAt: new Date().toISOString(),
        }),
      });
      onRefresh?.();
    } catch {
      // Cosmetic only — the step also completes on pairing.
    }
  }

  async function dismiss() {
    setDismissed(true);
    try {
      await apiCall(getToken, "/v1/me/preferences/onboarding", {
        method: "PUT",
        body: JSON.stringify({
          ...(me.onboarding || {}),
          dismissedAt: new Date().toISOString(),
        }),
      });
    } catch {
      // Local state already hid it for this session.
    }
  }

  async function startImport() {
    if (startingImport) return;
    setStartingImport(true);
    setImportError(null);
    try {
      // Folder-optional: the agent imports from the folders it
      // already watches.
      await apiCall(getToken, "/v1/import/start", {
        method: "POST",
        body: "{}",
      });
      importStatus.refresh();
    } catch (err) {
      const e = err as { message?: string; code?: string };
      setImportError(
        e.code === "import_already_running"
          ? null // card below will show the running job
          : e.message || "Couldn't start the import.",
      );
      importStatus.refresh();
    } finally {
      setStartingImport(false);
    }
  }

  return (
    <Card data-testid="onboarding-checklist">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-h3 font-bold text-text">
            Get your dashboard live
          </h2>
          <p className="mt-0.5 text-caption text-text-muted">
            Three steps — most players are done in under five minutes.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void dismiss()}>
          Dismiss
        </Button>
      </div>

      <ol className="mt-4 space-y-3">
        <ChecklistRow
          index={1}
          done={downloadDone}
          title="Download the agent"
          subtitle="It watches your replay folder and parses games locally."
          action={
            downloadDone ? null : (
              <CtaLink href="/download" onClick={() => void markDownloadStarted()}>
                <Download className="h-4 w-4" aria-hidden />
                Download
              </CtaLink>
            )
          }
        />

        <ChecklistRow
          index={2}
          done={pairDone}
          title="Pair this account"
          subtitle={
            pairDone ? (
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={[
                    "inline-block h-2 w-2 rounded-full",
                    agentOnline ? "bg-success" : "bg-text-dim",
                  ].join(" ")}
                />
                {agentOnline
                  ? "Agent online"
                  : "Agent paired — last seen a while ago. Make sure it's running."}
              </span>
            ) : (
              "The agent shows a 6-digit code when it starts — enter it on the Devices page."
            )
          }
          action={
            pairDone ? null : (
              <CtaLink href="/devices">Open Devices</CtaLink>
            )
          }
          expanded={downloadDone && !pairDone}
          expandedContent={
            downloadDone && !pairDone ? (
              <PairHint onPaired={onRefresh} />
            ) : null
          }
        />

        <ChecklistRow
          index={3}
          done={playDone}
          title="Import your replay history"
          subtitle="Light up the dashboard with every game you've already played — or just play a ranked match."
          action={
            playDone || !pairDone ? null : importStatus.active ? null : (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void startImport()}
                disabled={startingImport}
                loading={startingImport}
                iconLeft={<Play className="h-4 w-4" aria-hidden />}
              >
                Import my history
              </Button>
            )
          }
          expanded={pairDone && !playDone && (importStatus.active || !!importStatus.job)}
          expandedContent={
            pairDone && importStatus.job && (importStatus.active || !playDone) ? (
              <ImportProgressCard
                job={importStatus.job}
                active={importStatus.active}
                pct={importStatus.pct}
                etaSeconds={importStatus.etaSeconds}
                onCancelled={importStatus.refresh}
              />
            ) : null
          }
        />
      </ol>
      {importError ? (
        <p className="mt-2 text-caption text-danger" role="alert">
          {importError}
        </p>
      ) : null}
    </Card>
  );
}

function ChecklistRow({
  index,
  done,
  title,
  subtitle,
  action,
  expanded,
  expandedContent,
}: {
  index: number;
  done: boolean;
  title: string;
  subtitle: ReactNode;
  action?: ReactNode;
  expanded?: boolean;
  expandedContent?: ReactNode;
}) {
  return (
    <li className="rounded-xl border border-border bg-bg-elevated/40 p-3">
      <div className="flex items-center gap-3">
        <span
          className={[
            "inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border text-caption font-semibold",
            done
              ? "border-success/60 bg-success/10 text-success"
              : "border-accent-cyan bg-accent-cyan/15 text-accent-cyan",
          ].join(" ")}
          aria-hidden
        >
          {done ? <Check className="h-3.5 w-3.5" /> : index}
        </span>
        <div className="min-w-0 flex-1">
          <div
            className={[
              "text-body font-semibold",
              done ? "text-text-muted line-through decoration-success/50" : "text-text",
            ].join(" ")}
          >
            {title}
          </div>
          <div className="text-caption text-text-muted">{subtitle}</div>
        </div>
        {action ? <div className="flex-shrink-0">{action}</div> : null}
      </div>
      {expanded && expandedContent ? (
        <div className="mt-3 border-t border-border pt-3">{expandedContent}</div>
      ) : null}
    </li>
  );
}

const PAIR_POLL_MS = 5000;

/**
 * The agent generates the pairing code (shown in its window on first
 * run); the user enters it at /devices. While this hint is visible we
 * re-fetch /v1/me every few seconds so the row ticks green on its own
 * the moment the claim lands.
 */
function PairHint({ onPaired }: { onPaired?: () => void }) {
  useEffect(() => {
    if (!onPaired) return;
    const id = window.setInterval(onPaired, PAIR_POLL_MS);
    return () => window.clearInterval(id);
  }, [onPaired]);

  return (
    <ol className="ml-5 list-decimal space-y-1 text-caption text-text-muted">
      <li>Run the agent — a 6-digit code appears in its window.</li>
      <li>
        Enter the code on the{" "}
        <Link href="/devices" className="font-medium text-accent hover:text-accent-hover">
          Devices page
        </Link>
        .
      </li>
      <li className="inline-flex items-center gap-1.5">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        This row ticks green automatically once paired.
      </li>
    </ol>
  );
}

function CtaLink({
  href,
  onClick,
  children,
}: {
  href: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="inline-flex min-h-[36px] items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-caption font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      {children}
    </Link>
  );
}
