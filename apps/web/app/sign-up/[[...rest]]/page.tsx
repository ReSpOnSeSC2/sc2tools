"use client";

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

export default function SignUpPage() {
  return (
    <AuthShell marketing={<SignUpMarketing />}>
      {(theme) => (
        <SignUp
          key={theme}
          appearance={appearanceFor(theme)}
          signInUrl="/sign-in"
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
    icon: Layers,
    text: "Eight cloud features wired into one workflow — replays, dossiers, overlays, all from one sign-in.",
  },
  {
    icon: Tv,
    text: "Broadcast-ready overlay with 15 widgets and per-widget URLs for OBS.",
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
        Install a 450&nbsp;MB agent, finish a replay, and watch your
        opponent dossier fill out automatically.
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
