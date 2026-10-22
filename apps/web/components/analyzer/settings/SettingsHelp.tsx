"use client";

/**
 * Settings · Help — the help center inside the app: search, then every
 * help article (lib/help/articles) as a collapsible section grouped by
 * topic, with Getting started open by default, and the support line.
 * The same articles are public at /help.
 *
 * A section opens itself when the page is reached through its anchor
 * (e.g. ``?tab=help#build-check-in``); old anchors keep working through
 * each article's ``legacyAnchors``.
 */

import Link from "next/link";
import { ArrowUpRight, LifeBuoy } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { HelpCenter } from "@/components/help/HelpCenter";

export function SettingsHelp() {
  return (
    <Card>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-2">
          <LifeBuoy className="h-5 w-5 shrink-0 text-accent-cyan" aria-hidden />
          <div>
            <div className="text-h3 font-semibold text-text">Help & getting started</div>
            <p className="text-caption text-text-dim">
              Everything in one place — setup, the overlay, the Stream
              Studio, viewer commands, and fixes for common snags.
            </p>
          </div>
        </div>
        <Link
          href="/help"
          className="inline-flex min-h-11 shrink-0 items-center gap-1 self-start rounded-sm text-caption font-semibold text-accent-cyan underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:min-h-0"
        >
          Open the help center
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
      <HelpCenter />
    </Card>
  );
}
