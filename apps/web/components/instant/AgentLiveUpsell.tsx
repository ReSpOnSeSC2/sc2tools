"use client";

/**
 * AgentLiveUpsell — a soft "Install the agent for live features" note for
 * players who import in the browser. It lists only what the browser truly
 * cannot do (a web page can't read the SC2 client API on localhost:6119,
 * can't run with no tab open, can't drive StarCraft II for playback
 * capture, can't switch OBS scenes) and links to /download.
 *
 *   variant "card"   — a full card (Settings → Overlay).
 *   variant "inline" — one compact row (Today, above the live game panel).
 *
 * With `dismissKey` it gets a dismiss button remembered in localStorage;
 * it renders only after mount so a dismissed note never flashes.
 *
 * Example:
 *   <AgentLiveUpsell variant="inline" dismissKey="sc2tools.instant.agentUpsell.today" />
 */
import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { Clapperboard, Download, MonitorPlay, Radar, RefreshCw, X } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { useInstantImport } from "@/lib/instant/useInstantImport";
import { useLocalStorageState } from "@/lib/useLocalStorageState";

export interface AgentLiveUpsellProps {
  variant: "card" | "inline";
  /** localStorage key; when set the note can be dismissed for good. */
  dismissKey?: string;
  className?: string;
}

/** What only the desktop agent can do. Keep every line literally true. */
export const AGENT_LIVE_FEATURES = [
  {
    Icon: Radar,
    title: "Live pre-game scouting and OBS overlay data",
    detail: "A web page can't read the StarCraft II client API on localhost:6119.",
  },
  {
    Icon: RefreshCw,
    title: "Syncing while you play, with no tab open",
    detail: "The browser only syncs when you open or return to your SC2 Tools dashboard.",
  },
  {
    Icon: Clapperboard,
    title: "Accurate engine playback capture",
    detail: "Needs StarCraft II installed on the same PC.",
  },
  {
    Icon: MonitorPlay,
    title: "OBS scene switching",
    detail: "Switches scenes when a game starts and ends.",
  },
] as const;

const DOWNLOAD_LINK_CLASS = [
  "hard-press inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full border-2 border-line bg-bg-surface px-5",
  "font-display text-caption font-bold text-text hover:bg-bg-elevated",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
].join(" ");

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function DismissButton({ onDismiss }: { onDismiss: () => void }) {
  return (
    <button
      type="button"
      onClick={onDismiss}
      aria-label="Dismiss the agent suggestion"
      className={[
        "inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-text-muted",
        "hover:bg-bg-elevated hover:text-text",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
      ].join(" ")}
    >
      <X className="h-4 w-4" aria-hidden />
    </button>
  );
}

function DownloadLink({ label }: { label: string }) {
  return (
    <Link href="/download" className={DOWNLOAD_LINK_CLASS}>
      <Download className="h-4 w-4" aria-hidden />
      {label}
    </Link>
  );
}

function UpsellCard({ onDismiss, className }: { onDismiss?: () => void; className: string }) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className={["space-y-4 rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard", className].filter(Boolean).join(" ")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id={titleId} className="font-display text-h4 text-text">
            Install the agent for live features
          </h2>
          <p className="text-caption text-text-muted">
            Your replays are analyzed in the browser. These need the free desktop agent on your gaming PC:
          </p>
        </div>
        {onDismiss ? <DismissButton onDismiss={onDismiss} /> : null}
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {AGENT_LIVE_FEATURES.map(({ Icon, title, detail }) => (
          <li key={title} className="flex gap-2 text-caption">
            <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent-cyan" aria-hidden />
            <span className="min-w-0">
              <span className="block font-semibold text-text">{title}</span>
              <span className="text-text-muted">{detail}</span>
            </span>
          </li>
        ))}
      </ul>
      <DownloadLink label="Get the desktop agent" />
    </section>
  );
}

function UpsellInline({ onDismiss, className }: { onDismiss?: () => void; className: string }) {
  return (
    <section
      aria-label="Install the agent for live features"
      className={[
        "flex flex-col gap-3 rounded-xl border-2 border-line bg-bg-surface px-4 py-3 shadow-hard sm:flex-row sm:items-center",
        className,
      ].filter(Boolean).join(" ")}
    >
      <Radar className="hidden h-5 w-5 flex-shrink-0 text-accent-cyan sm:block" aria-hidden />
      <div className="min-w-0 flex-1">
        <h2 className="text-body font-bold text-text">Install the agent for live features</h2>
        <p className="text-caption text-text-muted">
          Live pre-game scouting, OBS overlay data and syncing while you play need the desktop agent — a web page
          can&apos;t read the StarCraft II client.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <DownloadLink label="Get the agent" />
        {onDismiss ? <DismissButton onDismiss={onDismiss} /> : null}
      </div>
    </section>
  );
}

function UpsellView({ variant, className, onDismiss }: { variant: AgentLiveUpsellProps["variant"]; className: string; onDismiss?: () => void }) {
  return variant === "card" ? (
    <UpsellCard onDismiss={onDismiss} className={className} />
  ) : (
    <UpsellInline onDismiss={onDismiss} className={className} />
  );
}

/**
 * The dismissible upsell. Renders nothing until the stored dismissal was
 * read, so a dismissed note never flashes.
 */
function DismissibleUpsell({ variant, dismissKey, className }: { variant: AgentLiveUpsellProps["variant"]; dismissKey: string; className: string }) {
  const [dismissed, setDismissed] = useLocalStorageState<boolean>(dismissKey, false, isBoolean);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // Runs in the same commit as the storage read above, so the first
    // visible render already knows whether the note was dismissed.
    setMounted(true);
  }, []);
  if (!mounted || dismissed) return null;
  return <UpsellView variant={variant} className={className} onDismiss={() => setDismissed(true)} />;
}

/**
 * The upsell (see module comment). Only a `dismissKey` upsell touches
 * localStorage.
 *
 * Example:
 *   <AgentLiveUpsell variant="card" />
 */
export function AgentLiveUpsell({ variant, dismissKey, className = "" }: AgentLiveUpsellProps) {
  if (dismissKey) return <DismissibleUpsell variant={variant} dismissKey={dismissKey} className={className} />;
  return <UpsellView variant={variant} className={className} />;
}

/**
 * The card upsell for Settings → Overlay, shown only when browser import
 * is enabled and the account has no paired agent (the overlay's live data
 * comes from the agent).
 *
 * Example:
 *   <OverlayAgentUpsell />
 */
export function OverlayAgentUpsell() {
  const { enabled } = useInstantImport();
  const { data } = useApi<{ agentPaired?: boolean }>(enabled ? "/v1/me" : null);
  if (!enabled || data?.agentPaired !== false) return null;
  return <AgentLiveUpsell variant="card" />;
}
