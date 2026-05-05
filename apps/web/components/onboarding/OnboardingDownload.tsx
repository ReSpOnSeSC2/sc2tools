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
 * pair from a manual install.
 */
export function OnboardingDownload({
  helpers,
}: {
  helpers: OnboardingHelpers;
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
          replays folder. Read-only. Your replay files never leave your
          machine — only the parsed game record syncs.
        </p>
      </header>

      <DownloadCard />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
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
