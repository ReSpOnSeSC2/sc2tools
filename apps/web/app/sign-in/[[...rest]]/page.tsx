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
import { isTryResumeRedirect, safeAuthRedirect } from "@/lib/instant/authRedirect";
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
  // Only the allowlisted /try hand-off forces a destination; otherwise
  // Clerk keeps its default behavior (no open redirects added here).
  const redirect = safeAuthRedirect(searchParams.get("redirect_url"));
  return (
    <SignIn
      key={theme}
      appearance={appearanceFor(theme)}
      signUpUrl="/sign-up"
      {...(redirect ? { forceRedirectUrl: redirect } : {})}
    />
  );
}

function WidgetPlaceholder() {
  return (
    <div
      className="min-h-[480px] rounded-xl border border-border bg-bg-surface/40"
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
      <LatestUpdate />
    </div>
  );
}
