"use client";

/**
 * OsPathHints — "where are my replays?" for Windows and macOS, the
 * visitor's own platform first, each path with a copy button. On phones
 * and tablets it adds how to get replays onto the device first.
 *
 * The platform is detected after mount (the server render lists Windows
 * first), so hydration never mismatches.
 *
 * Example:
 *   <OsPathHints id="replay-hints" />
 */
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { detectPlatform, osPathHints, type ClientPlatform, type OsPathHint } from "@/lib/instant/fileIntake";

/** How long the "Copied" confirmation stays visible. */
const COPIED_RESET_MS = 2000;
const MOBILE_PLATFORMS: ReadonlySet<ClientPlatform> = new Set<ClientPlatform>(["ios", "android"]);

export interface OsPathHintsProps {
  id?: string;
  /** True when the surrounding UI lets the visitor pick a whole folder. */
  folderPicking?: boolean;
  className?: string;
}

/**
 * Both desktop hints, the detected platform's first.
 *
 * Example:
 *   orderedPathHints("macos").map((hint) => hint.platform); // -> ["macos", "windows"]
 */
export function orderedPathHints(platform: ClientPlatform): OsPathHint[] {
  const primary = osPathHints(platform);
  const rest = osPathHints("other").filter((hint) => !primary.some((first) => first.platform === hint.platform));
  return [...primary, ...rest];
}

function CopyPathButton({ hint }: { hint: OsPathHint }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(hint.path);
    } catch {
      // Clipboard blocked (permissions / insecure context): the path stays
      // selectable in the <code> next to this button, so nothing else to do.
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  };
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={`Copy the ${hint.label} path`}
      className={[
        "inline-flex min-h-[44px] min-w-[44px] flex-shrink-0 items-center justify-center gap-1 rounded-full px-3",
        "text-caption font-semibold text-text-muted hover:bg-bg-elevated hover:text-text",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
      ].join(" ")}
    >
      <Icon className="h-4 w-4" aria-hidden />
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

/**
 * Accounts-folder locations with copy buttons.
 *
 * Example:
 *   <OsPathHints className="mt-3" />
 */
export function OsPathHints({ id, folderPicking = false, className = "" }: OsPathHintsProps) {
  const [platform, setPlatform] = useState<ClientPlatform>("other");
  useEffect(() => {
    setPlatform(detectPlatform(navigator.userAgent, navigator.maxTouchPoints));
  }, []);
  return (
    <div id={id} className={["space-y-2 text-caption text-text-muted", className].filter(Boolean).join(" ")}>
      <p>
        Ladder replays live in your StarCraft II <strong className="text-text">Accounts</strong> folder, under
        Accounts › (number) › (your player folder) › Replays › Multiplayer.
        {folderPicking ? " Choosing the whole Accounts folder also tells us exactly which player is you." : null}
      </p>
      <ul className="space-y-1">
        {orderedPathHints(platform).map((hint) => (
          <li key={hint.platform} className="flex min-w-0 items-center gap-2">
            <span className="w-16 flex-shrink-0 font-semibold text-text">{hint.label}</span>
            <code className="min-w-0 flex-1 break-all rounded-md bg-bg-elevated px-2 py-1 font-mono text-micro text-text">
              {hint.path}
            </code>
            <CopyPathButton hint={hint} />
          </li>
        ))}
      </ul>
      {MOBILE_PLATFORMS.has(platform) ? (
        <p>
          On a phone or tablet, save your replays (or a .zip of them) to Files first — for example from
          cloud storage — then choose them here.
        </p>
      ) : null}
    </div>
  );
}
