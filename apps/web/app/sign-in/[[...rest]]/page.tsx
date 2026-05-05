"use client";

import { SignIn } from "@clerk/nextjs";
import {
  Brain,
  Cloud,
  Sparkles,
  Tv,
  type LucideIcon,
} from "lucide-react";
import { AuthShell } from "@/components/auth/AuthShell";
import { appearanceFor } from "@/lib/clerk-appearance";

export default function SignInPage() {
  return (
    <AuthShell marketing={<SignInMarketing />}>
      {(theme) => (
        <SignIn
          key={theme}
          appearance={appearanceFor(theme)}
          signUpUrl="/sign-up"
        />
      )}
    </AuthShell>
  );
}

interface MarketingBullet {
  icon: LucideIcon;
  text: string;
}

const BULLETS: ReadonlyArray<MarketingBullet> = [
  {
    icon: Brain,
    text: "Replay parsing keeps running — every game classified in seconds.",
  },
  {
    icon: Cloud,
    text: "Opponent dossiers stay synced across every device you sign in on.",
  },
  {
    icon: Tv,
    text: "Your overlay URLs are unchanged — OBS keeps streaming uninterrupted.",
  },
];

function SignInMarketing() {
  return (
    <div className="space-y-6 md:space-y-7">
      <p className="inline-flex items-center gap-1.5 text-caption font-medium text-accent-cyan">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent-cyan shadow-halo-cyan" />
        Welcome back
      </p>
      <h1 className="text-h1 font-semibold leading-tight text-text md:text-display-lg">
        Sign in to <span className="text-accent-cyan">SC2 Tools</span>
      </h1>
      <p className="max-w-prose text-body-lg text-text-muted">
        Your replay history, opponent dossiers, and overlay layouts are
        right where you left them.
      </p>
      <ul className="space-y-3">
        {BULLETS.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-0.5 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan"
            >
              <Icon className="h-4 w-4" />
            </span>
            <span className="text-body text-text">{text}</span>
          </li>
        ))}
      </ul>
      <FeatureHighlight />
    </div>
  );
}

function FeatureHighlight() {
  return (
    <div className="rounded-lg border border-border bg-bg-elevated/60 p-4">
      <div className="flex items-start gap-3">
        <Sparkles
          className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent-cyan"
          aria-hidden
        />
        <p className="text-caption text-text-muted">
          <span className="font-semibold text-text">Latest:</span>{" "}
          ML build prediction now flags ZvT openers from the first scout —
          available the moment you sign in.
        </p>
      </div>
    </div>
  );
}
