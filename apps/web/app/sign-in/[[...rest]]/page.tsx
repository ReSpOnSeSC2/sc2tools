"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { SignIn } from "@clerk/nextjs";
import {
  Cloud,
  Replace,
  Tv,
  type LucideIcon,
} from "lucide-react";
import { LatestUpdate } from "@/components/auth/LatestUpdate";
import { TrySavePanel } from "@/components/auth/TrySavePanel";
import { AuthShell } from "@/components/auth/AuthShell";
import { appearanceFor } from "@/lib/clerk-appearance";
import { isTryResumeRedirect } from "@/lib/instant/authRedirect";
import { signUpHref } from "@/lib/authLinks";
import { authDestinations } from "@/lib/authDestinations";
import type { Theme } from "@/lib/theme";

export default function SignInPage() {
  return <Suspense fallback={<WidgetPlaceholder />}><SignInContent /></Suspense>;
}

function SignInContent() {
  const searchParams = useSearchParams();
  const tryResume = isTryResumeRedirect(searchParams.get("redirect_url"));
  return (
    <AuthShell lead={tryResume ? "Save your /try report" : "Welcome back to your replay history."} marketing={tryResume ? <TrySavePanel /> : <SignInMarketing />}>
      {(theme) => (
        // useSearchParams needs a Suspense boundary for the static build.
        <Suspense fallback={<WidgetPlaceholder />}>
          <SignInWidget theme={theme} />
        </Suspense>
      )}
    </AuthShell>
  );
}

function SignInWidget({ theme }: { theme: Theme }) {
  const searchParams = useSearchParams();
  // Only an allowlisted same-origin context can override Clerk's destination.
  const destination = authDestinations(searchParams.get("redirect_url"));
  return (
    <SignIn
      key={theme}
      appearance={appearanceFor(theme)}
      signUpUrl={signUpHref(destination.returnTo)}
      forceRedirectUrl={destination.signIn}
      signUpForceRedirectUrl={destination.signUp}
      fallbackRedirectUrl="/app"
    />
  );
}

function WidgetPlaceholder() {
  return (
    <div
      className="min-h-[480px] rounded-2xl border border-line bg-bg-surface/40"
      aria-hidden
    />
  );
}

interface MarketingBullet {
  icon: LucideIcon;
  text: string;
}

const BULLETS: ReadonlyArray<MarketingBullet> = [
  {
    icon: Replace,
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
    <div className="relative isolate space-y-6 md:space-y-7">
      <div aria-hidden className="pointer-events-none absolute -left-10 -top-16 -z-10 h-64 w-64 rounded-full bg-aurora opacity-10 blur-3xl" />
      <p className="hud-label inline-flex items-center gap-1.5 rounded-full border border-accent-cyan/30 bg-accent-cyan/10 px-3 py-1">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent-cyan shadow-halo-cyan" />
        Welcome back
      </p>
      <h1 className="font-display text-h1 font-extrabold leading-[1.05] tracking-[-0.04em] text-text md:text-display-lg">
        Sign in to <span className="aurora-text">SC2 Tools</span>
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
              className="mt-0.5 inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-accent-cyan/10 text-accent-cyan ring-1 ring-accent-cyan/30"
            >
              <Icon className="h-4 w-4" />
            </span>
            <span className="text-body text-text">{text}</span>
          </li>
        ))}
      </ul>
      <LatestUpdate />
    </div>
  );
}
