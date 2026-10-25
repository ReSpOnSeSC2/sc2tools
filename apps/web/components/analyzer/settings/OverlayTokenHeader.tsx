"use client";

import { Sparkles, Square, Tv } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { fmtAgo } from "@/lib/format";
import { appendOverlayCreditToUrl } from "@/lib/overlayCredit";
import type { OverlayTheme } from "@/lib/overlayTheme";
import type { OverlayProfile } from "@/lib/overlayProfile";
import { AgentStatusIndicator } from "./AgentStatusIndicator";
import { OverlayCreditToggle } from "./OverlayCreditToggle";
import { UrlRow } from "./OverlayUrlRow";
import { useOverlayCreditPreference } from "./useOverlayCreditPreference";

/*
 * Settings · Overlay: the active token's header row (label, last seen,
 * Test all) and its All-in-one URL row. Split out of SettingsOverlay.tsx
 * unchanged.
 */

/** One overlay token as /v1/overlay-tokens lists it. */
export type OverlayToken = {
  token: string;
  label: string;
  createdAt: string;
  lastSeenAt?: string | null;
  revokedAt?: string | null;
  enabledWidgets?: string[];
  profile?: OverlayProfile;
  profileRevision?: number;
};

export function ActiveTokenHeader({
  token,
  origin,
  onTestAll,
  testing,
  anyTesting,
}: {
  token: OverlayToken;
  origin?: string;
  onTestAll: () => void;
  testing: boolean;
  anyTesting: boolean;
}) {
  void origin;
  // Treat "testing this very button" specially so the click reads as
  // a Stop instead of a (no-op) repeat fire. Other widgets still see
  // the dimmed disabled state — there's only ever one in-flight test
  // at a time per token.
  const otherTesting = anyTesting && !testing;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
      <Tv className="h-4 w-4 flex-shrink-0 text-accent-cyan" aria-hidden />
      <span className="text-body font-medium text-text">{token.label}</span>
      <Badge variant="cyan" size="sm">
        {`${token.token.slice(0, 6)}…${token.token.slice(-4)}`}
      </Badge>
      <span className="ml-auto flex items-center gap-3">
        {/*
          Real-time agent indicator. Drives off the same SSE stream
          the dashboard uses, so green/grey here matches what the
          streamer would see from the /app dashboard's LiveGamePanel.
          ``token.lastSeenAt`` continues to surface OBS-side
          connectivity (when did this overlay token's Browser Source
          last open a socket?) — distinct from "is the agent emitting?"
        */}
        <AgentStatusIndicator />
        <span className="text-caption text-text-muted">
          {token.lastSeenAt
            ? `Seen ${fmtAgo(token.lastSeenAt)}`
            : "Not yet connected"}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={onTestAll}
          disabled={otherTesting}
          iconLeft={
            testing ? (
              <Square className="h-4 w-4" aria-hidden />
            ) : (
              <Sparkles className="h-4 w-4" aria-hidden />
            )
          }
          title={
            testing
              ? "Click to dismiss the test fire early"
              : "Fire sample data at every enabled widget"
          }
        >
          {testing ? "Stop test" : "Test all"}
        </Button>
      </span>
    </div>
  );
}

export function AllInOneRow({
  token,
  origin,
  theme,
}: {
  token: OverlayToken;
  origin?: string;
  theme: OverlayTheme;
}) {
  // New copies follow the saved profile; old explicit theme URLs still work.
  void theme;
  const [showCredit, setShowCredit] = useOverlayCreditPreference();
  const url = appendOverlayCreditToUrl(
    `${origin ?? ""}/overlay/${token.token}`,
    showCredit,
  );
  return (
    <div className="space-y-2 border-b border-border px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-caption font-semibold uppercase tracking-wider text-text-muted">
          All-in-one URL
        </span>
        <span className="text-caption text-text-muted">
          One Browser Source · core game widgets together; chat and studio widgets use their own URLs
        </span>
      </div>
      <UrlRow url={url} compact={false} />
      <OverlayCreditToggle checked={showCredit} onChange={setShowCredit} />
    </div>
  );
}
