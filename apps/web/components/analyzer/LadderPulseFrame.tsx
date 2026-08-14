"use client";

import type { ReactNode } from "react";
import { ChevronDown, Radio } from "lucide-react";
import { fmtAgo } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";

export function LadderPulseFrame({
  updatedAt,
  children,
  collapsed = false,
  onToggle,
  pending = false,
}: {
  updatedAt?: string | null;
  children?: ReactNode;
  collapsed?: boolean;
  onToggle?: () => void;
  pending?: boolean;
}) {
  const headerContent = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className="relative flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-accent-cyan/15 text-accent-cyan"
        >
          <span className="absolute inset-1 rounded-full border border-accent-cyan/40 motion-safe:animate-pulse" />
          <Radio className="relative h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="block text-body font-bold text-text">
            Ladder Pulse
          </span>
          <span className="block truncate text-micro text-text-dim">
            Latest synced replay · daily rediscovery · nightly ladder movement
          </span>
        </span>
      </span>
      <span className="flex flex-shrink-0 items-center gap-2">
        <Badge variant="cyan" size="sm" className="hidden sm:inline-flex">
          Replay-fed
        </Badge>
        {updatedAt ? (
          <span className="hidden text-micro text-text-dim md:inline">
            {fmtAgo(updatedAt)}
          </span>
        ) : null}
        {!pending ? (
          <ChevronDown
            aria-hidden
            className={`h-4 w-4 flex-shrink-0 text-text-dim transition-transform ${
              collapsed ? "-rotate-90" : ""
            }`}
          />
        ) : null}
      </span>
    </>
  );

  return (
    <Card
      variant="feature"
      padded={false}
      aria-labelledby="ladder-pulse-title"
      data-testid="ladder-pulse"
    >
      <header
        className={`bg-bg-elevated/60 ${
          collapsed || pending ? "" : "border-b border-border"
        }`}
      >
        <h2 id="ladder-pulse-title" className="sr-only">
          Ladder Pulse
        </h2>
        {pending ? (
          <div className="flex min-h-[56px] w-full items-center justify-between gap-3 px-4 py-3">
            {headerContent}
          </div>
        ) : (
          <button
            type="button"
            onClick={onToggle}
            aria-controls="ladder-pulse-content"
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? "Open" : "Close"} Ladder Pulse`}
            className="flex min-h-[56px] w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          >
            {headerContent}
          </button>
        )}
      </header>
      {!pending ? (
        <div id="ladder-pulse-content" hidden={collapsed}>
          {children}
        </div>
      ) : null}
    </Card>
  );
}
