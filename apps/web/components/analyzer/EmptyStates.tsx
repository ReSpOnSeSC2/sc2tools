"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import {
  Activity,
  Download,
  Filter,
  Gamepad2,
  Layers,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { GlowHalo } from "@/components/ui/GlowHalo";

/**
 * Specialised empty-state cards for the analyzer. Each one explains
 * what's missing and gives the next obvious step.
 *
 * - {@link NoGamesYet} is the dashboard hero shown when 0 games exist
 *   (full-bleed, with a cyan halo to draw the eye).
 * - The rest are inline empties used to indicate filters returned
 *   nothing.
 */

export function NoGamesYet() {
  return (
    <section
      className="relative overflow-hidden rounded-2xl border border-border bg-bg-surface px-4 py-12 sm:px-6 sm:py-20"
      data-testid="dashboard-no-games"
    >
      <GlowHalo color="cyan" position="top" opacity={0.85} size={70} />
      <div className="relative z-10">
        <EmptyStatePanel
          size="lg"
          icon={<Gamepad2 className="h-6 w-6" aria-hidden />}
          title="No games synced yet"
          description={
            <>
              Install the agent on your gaming PC, pair it from{" "}
              <Link
                href="/devices"
                className="text-accent underline-offset-2 hover:underline"
              >
                Devices
              </Link>
              , and play a ranked match. This page will tick the moment the
              replay lands.
            </>
          }
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <CtaLink href="/download" variant="primary">
                <Download className="h-4 w-4" aria-hidden />
                Download agent
              </CtaLink>
              <CtaLink href="/devices" variant="secondary">
                Open Devices
              </CtaLink>
            </div>
          }
        />
      </div>
    </section>
  );
}

export function NoOpponentsMatch() {
  return (
    <EmptyStatePanel
      size="md"
      icon={<Filter className="h-5 w-5" aria-hidden />}
      title="No opponents match these filters"
      description="Try lowering Min games, clearing the season filter, or searching by partial name."
    />
  );
}

export function NoBuildOrder({
  gameId,
  onRecompute,
}: {
  gameId: string;
  onRecompute: () => void;
}) {
  return (
    <EmptyStatePanel
      size="sm"
      icon={<Layers className="h-5 w-5" aria-hidden />}
      title="No build order parsed"
      description={
        <>
          for game{" "}
          <span className="font-mono text-[11px] text-text-dim">{gameId}</span>
        </>
      }
      action={
        <Button variant="secondary" size="sm" onClick={onRecompute}>
          Ask the agent to recompute
        </Button>
      }
    />
  );
}

export function NeedReplays({ count = 0 }: { count?: number }) {
  return (
    <EmptyStatePanel
      size="md"
      icon={<Activity className="h-5 w-5" aria-hidden />}
      title="Need more replays"
      description={
        <>
          You have <strong className="text-text">{count}</strong> games on file.
          Most charts work best with 30+. The agent will keep the cloud copy
          current as you play.
        </>
      }
    />
  );
}

interface CtaLinkProps {
  href: string;
  variant: "primary" | "secondary";
  children: ReactNode;
}

function CtaLink({ href, variant, children }: CtaLinkProps) {
  const variantClass =
    variant === "primary"
      ? "bg-accent text-white hover:bg-accent-hover"
      : "bg-bg-elevated text-text border border-border hover:bg-bg-subtle hover:border-border-strong";
  return (
    <Link
      href={href}
      className={[
        "inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-2 rounded-lg px-4 text-body font-semibold",
        "transition-colors duration-100",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        variantClass,
      ].join(" ")}
    >
      {children}
    </Link>
  );
}
