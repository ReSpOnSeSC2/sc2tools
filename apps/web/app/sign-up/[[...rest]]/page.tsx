"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { SignUp } from "@clerk/nextjs";
import {
  CreditCard,
  Layers,
  ShieldCheck,
  Tv,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { AuthShell } from "@/components/auth/AuthShell";
import { appearanceFor } from "@/lib/clerk-appearance";
import { safeAuthRedirect } from "@/lib/instant/authRedirect";
import { getInstantImportMode } from "@/lib/instant/flag";
import { PRODUCT_FACTS } from "@/lib/productFacts";
import type { Theme } from "@/lib/theme";

/** Where new accounts go unless /try asked to come back (see authRedirect). */
const WELCOME_PATH = "/welcome";

export default function SignUpPage() {
  return (
    <AuthShell marketing={<SignUpMarketing />}>
      {(theme) => (
        // useSearchParams needs a Suspense boundary for the static build.
        <Suspense fallback={<WidgetPlaceholder />}>
          <SignUpWidget theme={theme} />
        </Suspense>
      )}
    </AuthShell>
  );
}

function SignUpWidget({ theme }: { theme: Theme }) {
  const searchParams = useSearchParams();
  // Only the allowlisted /try hand-off may override the default; any
  // other ?redirect_url= is ignored (no open redirects).
  const redirect = safeAuthRedirect(searchParams.get("redirect_url"));
  return (
    <SignUp
      key={theme}
      appearance={appearanceFor(theme)}
      signInUrl="/sign-in"
      // New accounts land in the /welcome wizard (download → pair →
      // first sync) instead of an empty dashboard — unless they came
      // from /try to save the games they just analysed. Returning users
      // signing IN keep going straight to /app.
      forceRedirectUrl={redirect ?? WELCOME_PATH}
      fallbackRedirectUrl={WELCOME_PATH}
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
    icon: Layers,
    text: "Eight cloud features wired into one workflow — replays, dossiers, overlays, all from one sign-in.",
  },
  {
    icon: Tv,
    text: `Broadcast-ready overlay with ${PRODUCT_FACTS.overlayWidgets} widgets and per-widget URLs for OBS.`,
  },
  {
    icon: ShieldCheck,
    text: "Per-opener W-L, per-map veto data, and dossiers that survive opponent name changes.",
  },
];

function SignUpMarketing() {
  return (
    <div className="space-y-6 md:space-y-7">
      <FreeBadge />
      <h1 className="text-h1 font-semibold leading-tight text-text md:text-display-lg">
        Free in <span className="text-accent-cyan">30 seconds.</span>
        <br />
        No card.
      </h1>
      <p className="max-w-prose text-body-lg text-text-muted">
        Install the free Windows agent, finish a replay, and watch your
        opponent dossier fill out automatically.
      </p>
      {getInstantImportMode() === "all" ? (
        <p className="max-w-prose text-body text-text-muted">
          <Link
            href="/try"
            className="font-semibold text-accent-cyan underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Or analyze replays in your browser first — no download
          </Link>
        </p>
      ) : null}
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
      <PlayerQuote />
    </div>
  );
}

function FreeBadge() {
  return (
    <p className="inline-flex items-center gap-1.5 text-caption font-medium text-accent-cyan">
      <Zap className="h-3.5 w-3.5" aria-hidden />
      Free forever — no card required
    </p>
  );
}

function PlayerQuote() {
  return (
    <blockquote className="rounded-lg border border-border bg-bg-elevated/60 p-4">
      <div className="flex items-start gap-3">
        <CreditCard
          className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent-cyan"
          aria-hidden
        />
        <p className="text-caption text-text-muted">
          <span className="font-semibold text-text">No payment, ever.</span>{" "}
          The desktop agent and core cloud features are free for ladder
          players and casters across NA, EU, and KR.
        </p>
      </div>
    </blockquote>
  );
}
