"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Apple,
  Copy,
  Download,
  ShieldCheck,
  Terminal as LinuxIcon,
} from "lucide-react";
import { useReleaseInfo, formatBytes } from "./useReleaseInfo";
import { usePlatformDetect } from "./usePlatformDetect";
import type { DetectedOS } from "./types";

const OS_LABEL: Record<Exclude<DetectedOS, "unknown">, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

/**
 * Reusable download card. Used by both the onboarding flow's Step 2
 * and the standalone /download page. Pulls real release metadata from
 * `/v1/agent/version` so version, file size, and SHA-256 are never
 * hardcoded. Falls back to a "no installer yet" callout if the API
 * has nothing for the user's platform.
 */
export function DownloadCard({
  os: osOverride,
}: {
  /** Override the detected OS — used by /download to flip platforms. */
  os?: DetectedOS;
}) {
  const detectedOs = usePlatformDetect();
  const os = osOverride ?? detectedOs;
  const release = useReleaseInfo(os);

  if (release.isLoading) return <DownloadCardSkeleton />;
  if (release.error || !release.data?.artifact) {
    return <DownloadCardNoArtifact os={os} />;
  }

  const { artifact, latest, publishedAt, releaseNotes } = release.data;
  return (
    <article className="space-y-4 rounded-xl border border-accent-cyan/30 bg-bg-surface p-5 shadow-halo-cyan sm:p-6">
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-caption font-semibold uppercase tracking-wider text-text-muted">
            Latest stable · {os !== "unknown" ? OS_LABEL[os] : "Windows"}
          </p>
          <h3 className="text-h3 font-semibold text-text">
            SC2 Tools Agent <span className="text-text-muted">v{latest}</span>
          </h3>
          {publishedAt ? (
            <p className="text-caption text-text-dim">
              Released{" "}
              <time dateTime={publishedAt}>{formatDate(publishedAt)}</time>{" "}
              · {formatBytes(artifact.sizeBytes)}
            </p>
          ) : null}
        </div>
        <PlatformIcon os={os} />
      </header>

      <a
        href={artifact.downloadUrl}
        download
        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-accent-cyan px-5 text-body-lg font-semibold text-white shadow-halo-cyan transition-colors hover:bg-accent-cyan/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-bg sm:w-auto"
        aria-describedby="download-verify-hint"
      >
        <Download className="h-5 w-5" aria-hidden />
        Download for {OS_LABEL[osLabelKey(os)]}
      </a>

      <ShaSnippet sha={artifact.sha256} fileSize={artifact.sizeBytes} />

      {releaseNotes ? (
        <details className="group rounded-lg border border-border bg-bg-subtle/40 p-3">
          <summary className="cursor-pointer list-none text-caption font-medium text-text-muted hover:text-text">
            Release notes
            <span className="ml-1 text-text-dim group-open:hidden">▶</span>
            <span className="ml-1 hidden text-text-dim group-open:inline">
              ▼
            </span>
          </summary>
          <pre className="mt-3 max-h-[240px] overflow-auto whitespace-pre-wrap break-words text-caption text-text-muted">
            {releaseNotes}
          </pre>
        </details>
      ) : null}
    </article>
  );
}

function osLabelKey(os: DetectedOS): Exclude<DetectedOS, "unknown"> {
  return os === "unknown" ? "windows" : os;
}

function ShaSnippet({
  sha,
  fileSize,
}: {
  sha: string;
  fileSize: number | null;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(sha);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — surface nothing; user can select manually */
    }
  }
  return (
    <div
      id="download-verify-hint"
      className="rounded-lg border border-border bg-bg-subtle/40 p-3"
    >
      <div className="flex items-start gap-2">
        <ShieldCheck
          className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent-cyan"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-caption font-medium text-text">
            Verify before installing
          </p>
          <p className="mt-0.5 text-caption text-text-muted">
            Compare this SHA-256 with the one your OS reports
            {fileSize ? ` (${formatBytes(fileSize)} expected)` : ""}.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded border border-border bg-bg-elevated px-2 py-1 font-mono text-[11px] text-text">
              {sha}
            </code>
            <button
              type="button"
              onClick={copy}
              aria-label="Copy SHA-256 to clipboard"
              className="inline-flex h-8 min-w-[44px] items-center justify-center gap-1 rounded-md border border-border bg-bg-surface px-2 text-caption text-text-muted hover:bg-bg-elevated hover:text-text"
            >
              <Copy className="h-3.5 w-3.5" aria-hidden />
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DownloadCardSkeleton() {
  return (
    <article
      className="space-y-3 rounded-xl border border-border bg-bg-surface p-5 sm:p-6"
      aria-busy="true"
      aria-label="Loading the latest release"
    >
      <div className="h-5 w-40 animate-pulse rounded bg-bg-subtle" />
      <div className="h-7 w-64 animate-pulse rounded bg-bg-subtle" />
      <div className="h-12 w-full animate-pulse rounded-lg bg-bg-subtle sm:w-56" />
      <div className="h-16 w-full animate-pulse rounded-lg bg-bg-subtle" />
    </article>
  );
}

function DownloadCardNoArtifact({ os }: { os: DetectedOS }) {
  const isLinux = os === "linux";
  return (
    <article className="space-y-3 rounded-xl border border-warning/40 bg-warning/5 p-5 sm:p-6">
      <header className="flex items-start gap-2">
        <AlertTriangle
          className="mt-0.5 h-5 w-5 flex-shrink-0 text-warning"
          aria-hidden
        />
        <div className="min-w-0 space-y-1">
          <h3 className="text-body-lg font-semibold text-text">
            No installer published yet
            {isLinux ? " for Linux" : os === "macos" ? " for macOS" : ""}
          </h3>
          <p className="text-caption text-text-muted">
            Run the agent from source while we ship signed binaries.
            Both flows produce identical results.
          </p>
        </div>
      </header>
      <pre className="overflow-x-auto rounded-lg border border-border bg-bg-subtle/40 p-3 text-caption">
        {`git clone https://github.com/ReSpOnSeSC2/sc2tools.git
cd sc2tools/apps/agent
py -m pip install -r requirements.txt
py -m sc2tools_agent`}
      </pre>
    </article>
  );
}

function PlatformIcon({ os }: { os: DetectedOS }) {
  const className = "h-8 w-8 text-accent-cyan";
  if (os === "macos") return <Apple className={className} aria-hidden />;
  if (os === "linux") return <LinuxIcon className={className} aria-hidden />;
  // Windows / unknown → use a generic glyph.
  return (
    <span
      className="inline-flex h-8 w-8 items-center justify-center rounded bg-accent-cyan/10 text-accent-cyan"
      aria-hidden
    >
      <Download className="h-4 w-4" />
    </span>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

