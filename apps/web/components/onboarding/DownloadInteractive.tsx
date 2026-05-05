"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  ShieldCheck,
} from "lucide-react";
import { DownloadCard } from "./DownloadCard";
import { usePlatformDetect } from "./usePlatformDetect";
import type { DetectedOS } from "./types";

const OS_TABS: ReadonlyArray<{ id: DetectedOS; label: string }> = [
  { id: "windows", label: "Windows" },
  { id: "macos", label: "macOS" },
  { id: "linux", label: "Linux" },
];

const SYS_REQUIREMENTS: ReadonlyArray<{ heading: string; body: string }> = [
  {
    heading: "Disk",
    body: "~80 MB for the agent and its parser cache. The replay folder itself is untouched.",
  },
  {
    heading: "OS",
    body: "Windows 10+, macOS 12+, or modern x86_64 Linux. The Windows build is signed; macOS/Linux ship as source.",
  },
  {
    heading: "Network",
    body: "Outbound HTTPS to api.sc2tools.app. No inbound ports — your replays never leave the machine.",
  },
  {
    heading: "StarCraft II",
    body: "A live install with at least one ranked game on disk. Both 1v1 and team replays parse.",
  },
];

/**
 * Interactive shell for the /download page. Rendered as a client
 * island so the page-level server component can keep using the
 * filesystem-backed `<Banner />` (which fails when pulled into a
 * client bundle because it imports `fs`).
 */
export function DownloadInteractive() {
  const detected = usePlatformDetect();
  const [active, setActive] = useState<DetectedOS | null>(null);
  const os = active ?? (detected === "unknown" ? "windows" : detected);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_minmax(260px,360px)]">
      <section className="space-y-4">
        <OsTabs active={os} onChange={setActive} detected={detected} />
        <DownloadCard os={os} />
        <ManualInstall />
      </section>

      <aside className="space-y-4">
        <RecapCard />
        <SysReqCard />
      </aside>
    </div>
  );
}

function OsTabs({
  active,
  onChange,
  detected,
}: {
  active: DetectedOS;
  onChange: (next: DetectedOS) => void;
  detected: DetectedOS;
}) {
  return (
    <div
      role="tablist"
      aria-label="Choose your operating system"
      className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-border bg-bg-subtle/40 p-1"
    >
      {OS_TABS.map((t) => {
        const isActive = active === t.id;
        const isDetected = detected === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.id)}
            className={[
              "inline-flex h-9 min-w-[88px] items-center justify-center gap-1.5 rounded-md px-3 text-caption font-medium transition-colors",
              isActive
                ? "bg-bg-surface text-text shadow-[var(--shadow-card)]"
                : "text-text-muted hover:bg-bg-elevated hover:text-text",
            ].join(" ")}
          >
            {t.label}
            {isDetected && !isActive ? (
              <span className="rounded-full bg-accent-cyan/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent-cyan">
                detected
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function ManualInstall() {
  return (
    <details className="group rounded-xl border border-border bg-bg-surface">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-4 sm:p-5">
        <div className="min-w-0">
          <h3 className="text-body-lg font-semibold text-text">
            Manual install + verification
          </h3>
          <p className="text-caption text-text-muted">
            Run from source or verify the signed binary by hand.
          </p>
        </div>
        <ChevronRight
          className="h-5 w-5 flex-shrink-0 text-text-muted group-open:hidden"
          aria-hidden
        />
        <ChevronDown
          className="hidden h-5 w-5 flex-shrink-0 text-text-muted group-open:block"
          aria-hidden
        />
      </summary>
      <div className="space-y-4 border-t border-border px-4 py-4 sm:px-5 sm:py-5">
        <div className="space-y-2">
          <h4 className="text-caption font-semibold uppercase tracking-wider text-text-muted">
            Run from source
          </h4>
          <pre className="overflow-x-auto rounded-lg border border-border bg-bg-subtle/40 p-3 text-caption">
            {`git clone https://github.com/ReSpOnSeSC2/sc2tools.git
cd sc2tools/apps/agent
py -m pip install -r requirements.txt
py -m sc2tools_agent`}
          </pre>
        </div>
        <div className="space-y-2">
          <h4 className="text-caption font-semibold uppercase tracking-wider text-text-muted">
            Verify the SHA-256
          </h4>
          <p className="text-caption text-text-muted">
            On Windows PowerShell:
          </p>
          <pre className="overflow-x-auto rounded-lg border border-border bg-bg-subtle/40 p-3 text-caption">
            {`Get-FileHash .\\sc2tools-agent.exe -Algorithm SHA256`}
          </pre>
          <p className="text-caption text-text-muted">On macOS / Linux:</p>
          <pre className="overflow-x-auto rounded-lg border border-border bg-bg-subtle/40 p-3 text-caption">
            {`shasum -a 256 sc2tools-agent`}
          </pre>
          <p className="text-caption text-text-muted">
            The output should match the SHA-256 the download card
            shows above.
          </p>
        </div>
      </div>
    </details>
  );
}

function RecapCard() {
  return (
    <div className="space-y-2 rounded-xl border border-border bg-bg-surface p-4 sm:p-5">
      <header className="flex items-center gap-2">
        <Activity className="h-5 w-5 text-accent-cyan" aria-hidden />
        <h3 className="text-body-lg font-semibold text-text">What it does</h3>
      </header>
      <ul
        role="list"
        className="ml-5 list-disc space-y-1 text-caption text-text-muted"
      >
        <li>Watches your StarCraft II replay folder for new files.</li>
        <li>
          Parses each new <code>.SC2Replay</code> with sc2reader (~150–500&nbsp;ms
          per replay).
        </li>
        <li>
          Uploads the parsed JSON record to your account. The replay
          file itself never leaves your machine.
        </li>
      </ul>
      <p className="pt-1 text-caption text-text-dim">
        Already have an account?{" "}
        <Link
          href="/devices"
          className="text-accent-cyan underline-offset-2 hover:underline"
        >
          Pair a new machine →
        </Link>
      </p>
    </div>
  );
}

function SysReqCard() {
  return (
    <div className="space-y-3 rounded-xl border border-border bg-bg-surface p-4 sm:p-5">
      <header className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-accent-cyan" aria-hidden />
        <h3 className="text-body-lg font-semibold text-text">
          System requirements
        </h3>
      </header>
      <dl className="space-y-2 text-caption">
        {SYS_REQUIREMENTS.map((r) => (
          <div key={r.heading}>
            <dt className="font-semibold text-text">{r.heading}</dt>
            <dd className="text-text-muted">{r.body}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
