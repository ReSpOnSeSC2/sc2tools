"use client";

import * as React from "react";
import { useId, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Apple,
  Copy,
  ChevronDown,
  ChevronRight,
  Download,
  ShieldCheck,
  Terminal as LinuxIcon,
} from "lucide-react";
import { useReleaseInfo, formatBytes } from "./useReleaseInfo";
import { usePlatformDetect } from "./usePlatformDetect";
import { useIsMobileDevice } from "./useIsMobileDevice";
import { SendToPcCard } from "./SendToPcCard";
import { gaEvent } from "@/lib/analytics/gtag";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { getInstantImportMode } from "@/lib/instant/flag";
import type { DetectedOS } from "./types";
import { Button } from "@/components/ui/Button";
import { CODE_LOCATION, smartScreenNote, sourceInstallSnippet } from "@/lib/agentInstallerCopy";
import { MiniMarkdown } from "@/components/ui/MiniMarkdown";

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
 * has nothing for the user's platform. Phones and tablets, which can't
 * run the agent, get a send-the-link-to-your-PC card instead.
 */
export function DownloadCard({
  os: osOverride,
}: {
  /** Override the detected OS — used by /download to flip platforms. */
  os?: DetectedOS;
}) {
  const detectedOs = usePlatformDetect();
  const mobile = useIsMobileDevice();
  const os = osOverride ?? detectedOs;
  const release = useReleaseInfo(os);
  const [retrying, setRetrying] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const notesId = useId();

  if (mobile) return <SendToPcCard />;
  if (!release.error && (release.isLoading || !release.data)) return <DownloadCardSkeleton />;
  if (release.error) return <article className="space-y-3 rounded-xl border border-warning/40 bg-bg-surface p-5 sm:p-6">
    <h3 className="text-h3 font-semibold text-text">Couldn&apos;t reach the release server</h3>
    <p className="text-body text-text-muted">GitHub may be rate-limiting us. Try again in a minute, or download straight from GitHub.</p>
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="secondary" loading={retrying} aria-busy={retrying || release.isValidating || undefined} onClick={() => { setRetrying(true); void release.mutate().catch(() => {}).finally(() => setRetrying(false)); }}>Retry</Button>
      <a href="https://github.com/ReSpOnSeSC2/sc2tools/releases" className="text-accent-cyan underline">Download from GitHub Releases</a>
    </div>
  </article>;
  if (!release.data?.artifact) return <DownloadCardNoArtifact os={os} />;

  const { artifact, latest, publishedAt, releaseNotes } = release.data;
  const size = formatBytes(artifact.sizeBytes);
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
          {publishedAt || size !== "unknown" ? (
            <p className="text-caption text-text-dim">
              {publishedAt ? <>Released <time dateTime={publishedAt}>{formatDate(publishedAt)}</time></> : null}
              {size !== "unknown" ? <>{publishedAt ? " · " : ""}{size}</> : null}
            </p>
          ) : null}
        </div>
        <PlatformIcon os={os} />
      </header>

      <form
        action="/api/download/agent"
        method="post"
        onSubmit={() => {
          gaEvent("agent_download", {
            platform: osLabelKey(os),
            version: latest,
          });
        }}
      >
        <input type="hidden" name="platform" value={osLabelKey(os)} />
        <input type="hidden" name="artifactUrl" value={artifact.downloadUrl} />
        <button
          type="submit"
          className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-accent-cyan px-5 text-body-lg font-semibold text-white shadow-halo-cyan transition-colors hover:bg-accent-cyan/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-bg sm:w-auto"
          aria-describedby="download-verify-hint"
        >
          <Download className="h-5 w-5" aria-hidden />
          Download for {OS_LABEL[osLabelKey(os)]}
        </button>
      </form>

      <ShaSnippet sha={artifact.sha256} fileSize={artifact.sizeBytes} />

      <NextSteps />

      {releaseNotes ? (
        <section className="rounded-lg border border-border bg-bg-subtle/40 p-3">
          <button type="button" aria-expanded={notesOpen} aria-controls={notesId} onClick={() => setNotesOpen((open) => !open)} className="flex min-h-9 items-center gap-1 text-caption font-medium text-text-muted hover:text-text">
            {notesOpen ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}Release notes
          </button>
          {notesOpen ? <div id={notesId}><MiniMarkdown text={releaseNotes} className="mt-3 max-h-[240px] overflow-auto" /></div> : null}
        </section>
      ) : null}
      <a href="https://github.com/ReSpOnSeSC2/sc2tools/releases" className="inline-block text-caption text-accent-cyan underline">All releases</a>
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
            <code className="min-w-0 flex-1 break-all rounded border border-border bg-bg-elevated px-2 py-1 font-mono text-micro text-text">
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

/**
 * Post-download walkthrough — agent installer flow.
 *
 * Non-technical users tend to bail out after clicking Download because
 * they don't know whether to trust the SmartScreen warning, where the
 * installer puts things, or how to pair the agent to their account.
 * We spell out all five steps here so they can't get stuck.
 */
function NextSteps() {
  const steps: ReadonlyArray<{ heading: string; body: React.ReactNode }> = [
    {
      heading: "Double-click the installer",
      body: <>in your Downloads folder. It installs in seconds.</>,
    },
    {
      heading: "If Windows shows a blue “protected your PC” prompt",
      body: (
        <>
          {smartScreenNote}
        </>
      ),
    },
    {
      heading: "Click Next, then Install",
      body: <>the defaults are fine. Per-user install, no admin password needed.</>,
    },
    {
      heading: "The Agent window opens automatically",
      body: (
        <>
          Use the 6-digit code {CODE_LOCATION}. Click <em>Open pairing
          page</em> and sign into SC2 Tools. The page opens with the code
          already filled in, so click <em>Link this PC</em> and confirm the
          PC details. <LazyHelpLink slug="install-and-pair">Install and linking help</LazyHelpLink>
        </>
      ),
    },
    {
      heading: "It runs in the background from now on",
      body: (
        <>
          Look for the SC2 Tools icon in your system tray (next to the
          clock). Every replay you finish is parsed and synced
          automatically to your private account library, including the
          original file used by Replay download.
        </>
      ),
    },
  ];

  return (
    <div className="rounded-lg border border-border bg-bg-subtle/40 p-4">
      <p className="mb-3 text-caption font-semibold uppercase tracking-wider text-text-muted">
        After you download
      </p>
      <ol className="space-y-2.5 text-caption text-text">
        {steps.map((s, i) => (
          <li key={s.heading} className="flex gap-3">
            <span
              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-accent-cyan/15 text-micro font-semibold text-accent-cyan"
              aria-hidden
            >
              {i + 1}
            </span>
            <span>
              <strong className="font-semibold text-text">
                {s.heading}
              </strong>{" "}
              {s.body}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-3 border-t border-border/60 pt-3 text-caption text-text-muted">
        Already paired this machine?{" "}
        <Link
          href="/devices"
          className="text-accent-cyan underline-offset-2 hover:underline"
        >
          Manage your devices →
        </Link>
      </p>
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
  const isMac = os === "macos";
  return (
    <article className="space-y-3 rounded-xl border border-warning/40 bg-warning/5 p-5 sm:p-6">
      {(isMac || isLinux) && getInstantImportMode() === "all" ? <BrowserAnalyzerLead /> : null}
      <header className="flex items-start gap-2">
        <AlertTriangle
          className="mt-0.5 h-5 w-5 flex-shrink-0 text-warning"
          aria-hidden
        />
        <div className="min-w-0 space-y-1">
          <h3 className="text-body-lg font-semibold text-text">
            No installer published yet
            {isLinux ? " for Linux" : isMac ? " for macOS" : ""}
          </h3>
          <p className="text-caption text-text-muted">
            Run the agent from source when your platform has no installer.
            The same replay analysis runs locally.
          </p>
        </div>
      </header>
      <pre className="overflow-x-auto rounded-lg border border-border bg-bg-subtle/40 p-3 text-caption">
        {sourceInstallSnippet(os)}
      </pre>
    </article>
  );
}

/**
 * The easy path for Mac and Linux visitors: the in-browser analyzer
 * needs no install at all (shown only while /try is public).
 */
function BrowserAnalyzerLead() {
  return (
    <div className="rounded-lg border border-accent-cyan/30 bg-bg-surface p-4">
      <p className="text-body font-semibold text-text">Not on Windows? Analyze your replays in your browser.</p>
      <p className="mt-1 text-caption text-text-muted">
        The same analysis runs right in the page, with nothing to install.
      </p>
      <Link
        href="/try"
        className="mt-3 inline-flex min-h-11 items-center justify-center rounded-lg bg-accent-cyan px-4 text-body font-semibold text-white hover:bg-accent-cyan/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        Open the replay analyzer
      </Link>
    </div>
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

