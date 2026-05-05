"use client";

import { useUser } from "@clerk/nextjs";
import { Activity, BarChart3, Radio } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { OnboardingHelpers } from "./OnboardingShell";

const PILLARS: ReadonlyArray<{
  icon: typeof Activity;
  title: string;
  body: string;
}> = [
  {
    icon: Activity,
    title: "Live opponent intel",
    body: "Every ranked match parsed in the background — strategies, build orders, and timings on tap.",
  },
  {
    icon: BarChart3,
    title: "Macro and micro signals",
    body: "SQ, APM, expansions, gas saturation, supply blocks — all tracked across your last games.",
  },
  {
    icon: Radio,
    title: "OBS overlay",
    body: "Mint a token and paste one URL into a Browser Source — your stream stays in sync.",
  },
];

/**
 * Step 1 — Welcome. Brief product orientation. No data fetching here;
 * we read the signed-in user's first name straight from Clerk so the
 * greeting works without any API round-trip.
 */
export function OnboardingWelcome({ helpers }: { helpers: OnboardingHelpers }) {
  const { user, isLoaded } = useUser();
  const firstName = isLoaded
    ? user?.firstName?.trim() ||
      user?.username?.trim() ||
      user?.primaryEmailAddress?.emailAddress?.split("@")[0]
    : null;

  return (
    <section
      aria-labelledby="onboarding-step-heading"
      className="space-y-8"
    >
      <header className="space-y-3">
        <h1
          id="onboarding-step-heading"
          tabIndex={-1}
          className="text-display-lg font-semibold tracking-tight text-text outline-none"
        >
          {firstName ? `Welcome, ${firstName}.` : "Welcome to SC2 Tools."}
        </h1>
        <p className="text-body-lg text-text-muted">
          Two minutes of setup. Then your dashboard fills with every
          ranked match the moment it ends.
        </p>
      </header>

      <ul role="list" className="grid gap-3 sm:grid-cols-1">
        {PILLARS.map(({ icon: Icon, title, body }) => (
          <li
            key={title}
            className="flex items-start gap-3 rounded-xl border border-border bg-bg-surface p-4"
          >
            <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-accent-cyan/10 text-accent-cyan">
              <Icon className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h3 className="text-body font-semibold text-text">{title}</h3>
              <p className="mt-0.5 text-caption text-text-muted">{body}</p>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <Button
          size="lg"
          onClick={helpers.next}
          aria-label="Continue to the download step"
        >
          Get started →
        </Button>
      </div>
    </section>
  );
}
