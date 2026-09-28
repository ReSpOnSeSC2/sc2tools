"use client";

import { Button } from "@/components/ui/Button";
import { DownloadCard } from "./DownloadCard";
import type { OnboardingHelpers } from "./OnboardingShell";

/**
 * Step 2 — Download. Shows the OS-aware DownloadCard with real release
 * metadata from `/v1/agent/version`. The card decides whether to render
 * a download button or a "build from source" callout.
 *
 * "I downloaded it" advances to Step 3. We never block — even if the
 * card is in a "no installer" state, the user can still continue and
 * pair from a manual install. When `onBrowserImport` is given (Instant
 * Analysis enabled) a secondary button skips the download entirely and
 * imports replays in the browser instead.
 */
export function OnboardingDownload({
  helpers,
  onBrowserImport,
}: {
  helpers: OnboardingHelpers;
  onBrowserImport?: () => void;
}) {
  return (
    <section
      aria-labelledby="onboarding-step-heading"
      className="space-y-8"
    >
      <header className="space-y-2">
        <h1
          id="onboarding-step-heading"
          tabIndex={-1}
          className="text-display-lg font-semibold tracking-tight text-text outline-none"
        >
          Download the agent
        </h1>
        <p className="text-body-lg text-text-muted">
          A small background program that watches your StarCraft II
          replays folder without modifying it. Parsed game data and original
          replay files sync securely to your private account library so you
          can review or download them later.
        </p>
      </header>

      <DownloadCard />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        {onBrowserImport ? (
          <Button variant="secondary" size="lg" onClick={onBrowserImport}>
            Skip the download — import in your browser
          </Button>
        ) : null}
        <Button
          size="lg"
          onClick={helpers.next}
          aria-label="I downloaded the agent — continue to pairing"
        >
          I downloaded it →
        </Button>
      </div>
    </section>
  );
}
