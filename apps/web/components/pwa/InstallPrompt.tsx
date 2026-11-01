"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useInstallState } from "@/lib/pwa/install";
import { Button } from "@/components/ui/Button";
import { InstallInstructions } from "./InstallInstructions";
import { Download, MoreVertical, X } from "lucide-react";

/**
 * InstallPrompt — mobile-only "Add to Home Screen" banner for the PWA.
 *
 *   - Android / Chromium: listens for `beforeinstallprompt`, fires the
 *     native install dialog on tap. If Chrome won't open it (e.g. the
 *     deferred event was already consumed) we fall back to a sheet that
 *     walks the user through Chrome ⋮ → Install app.
 *   - iOS Safari: no programmatic install API exists, so the banner
 *     opens a Share → Add to Home Screen recipe sheet instead.
 *
 * The 30-day localStorage cooldown is written ONLY on explicit dismissal
 * (X button) or after a confirmed install. Cancelling the native dialog
 * or a `prompt()` failure leaves the banner visible so the user can
 * retry — earlier versions silently wrote the cooldown on every miss,
 * which dead-ended users who had any hiccup with Chrome's flow.
 *
 * The cooldown is also cleared whenever `beforeinstallprompt` fires
 * again: if Chrome still wants us to prompt, the app isn't installed,
 * so a stale cooldown shouldn't keep the banner hidden.
 */

const DISMISS_KEY = "sc2tools.pwa.installPromptDismissedAt";
const DISMISS_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

type Platform = "android" | "ios" | "other";
type InstallStatus = "idle" | "prompting" | "installed" | "cancelled" | "unavailable";

function readDismissedAt(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    return raw ? Number.parseInt(raw, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

function writeDismissedAt(ts: number): void {
  if (typeof window === "undefined") return;
  try {
    if (ts <= 0) {
      window.localStorage.removeItem(DISMISS_KEY);
    } else {
      window.localStorage.setItem(DISMISS_KEY, String(ts));
    }
  } catch {
    // localStorage may be blocked (private mode, embedded contexts) —
    // the banner just reappears next visit, which is acceptable.
  }
}

export function InstallPrompt() {
  const { available, installed, platform: detected, promptInstall, promptVersion } = useInstallState();
  const platform: Platform = detected.startsWith("ios") ? "ios" : detected === "android" ? "android" : "other";
  const [dismissed, setDismissed] = useState(false);
  const [showIosSheet, setShowIosSheet] = useState(false);
  const [showAndroidFallback, setShowAndroidFallback] = useState(false);
  const [status, setStatus] = useState<InstallStatus>("idle");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);

    const dismissedAt = readDismissedAt();
    if (dismissedAt && Date.now() - dismissedAt < DISMISS_COOLDOWN_MS) {
      setDismissed(true);
    }
  }, []);

  useEffect(() => {
    if (available) { writeDismissedAt(0); setDismissed(false); }
  }, [available, promptVersion]);
  useEffect(() => {
    if (installed) { setStatus("installed"); writeDismissedAt(Date.now()); }
  }, [installed]);
  const handleInstall = useCallback(async () => {
    if (platform === "ios") { setShowIosSheet(true); return; }
    if (!available) { setStatus("unavailable"); setShowAndroidFallback(true); return; }
    setStatus("prompting");
    const outcome = await promptInstall();
    if (outcome === "accepted") { setStatus("installed"); writeDismissedAt(Date.now()); }
    else if (outcome === "dismissed") setStatus("cancelled");
    else { setStatus("unavailable"); setShowAndroidFallback(true); }
  }, [available, platform, promptInstall]);

  const handleDismiss = useCallback(() => {
    writeDismissedAt(Date.now());
    setDismissed(true);
    setShowIosSheet(false);
    setShowAndroidFallback(false);
  }, []);

  const visible = useMemo(() => {
    if (!mounted) return false;
    if (installed || dismissed) return false;
    if (platform === "android") {
      // Keep the banner up after a cancel/unavailable so the user can
      // retry or open the fallback sheet — even if the deferred event
      // is now null.
      return available || status === "cancelled" || status === "unavailable";
    }
    if (platform === "ios") return true;
    return false;
  }, [mounted, installed, dismissed, platform, available, status]);

  if (!visible) return null;

  return (
    <>
      <InstallBanner
        platform={platform}
        status={status}
        canPromptNatively={available}
        onInstall={handleInstall}
        onDismiss={handleDismiss}
        onOpenFallback={() => setShowAndroidFallback(true)}
      />
      {showIosSheet ? <InstallInstructions platform={detected} onClose={() => setShowIosSheet(false)} /> : null}
      {showAndroidFallback ? (
        <InstallInstructions platform="android" onClose={() => setShowAndroidFallback(false)} />
      ) : null}
    </>
  );
}

interface InstallBannerProps {
  platform: Platform;
  status: InstallStatus;
  canPromptNatively: boolean;
  onInstall: () => void;
  onDismiss: () => void;
  onOpenFallback: () => void;
}

function bannerCopy(platform: Platform, status: InstallStatus, canPromptNatively: boolean) {
  if (platform === "ios") {
    return {
      ctaLabel: "How to install",
      title: "Install SC2 Tools",
      body: "Add to your home screen for one-tap access on the go.",
      hint: null as string | null,
    };
  }
  if (status === "prompting") {
    return {
      ctaLabel: "Opening install dialog…",
      title: "Install SC2 Tools",
      body: "Confirm the Chrome dialog to add SC2 Tools to your home screen.",
      hint: null,
    };
  }
  if (status === "cancelled") {
    return {
      ctaLabel: canPromptNatively ? "Install app" : "Show install steps",
      title: "Install cancelled",
      body: "No problem — tap below to try again or see the manual steps.",
      hint: "Or use Chrome ⋮ → Install app.",
    };
  }
  if (status === "unavailable") {
    return {
      ctaLabel: "Show install steps",
      title: "Install SC2 Tools",
      body: "Chrome didn't open the install dialog. Tap below for the manual steps.",
      hint: null,
    };
  }
  return {
    ctaLabel: "Install app",
    title: "Install SC2 Tools",
    body: "Add to your home screen for one-tap access on the go.",
    hint: null,
  };
}

function InstallBanner({
  platform,
  status,
  canPromptNatively,
  onInstall,
  onDismiss,
  onOpenFallback,
}: InstallBannerProps) {
  const copy = bannerCopy(platform, status, canPromptNatively);
  const prompting = status === "prompting";
  // On Android the primary button does double duty: native prompt when
  // a deferred event is live, fallback sheet otherwise.
  const handleCta = platform === "android" && !canPromptNatively ? onOpenFallback : onInstall;
  return (
    <section
      aria-label="Install SC2 Tools as a mobile app"
      className={[
        "relative mx-auto max-w-3xl overflow-hidden rounded-2xl",
        "border border-accent-cyan/40 bg-bg-elevated/80 backdrop-blur",
        "shadow-halo-cyan",
        "md:hidden",
      ].join(" ")}
    >
      <div className="flex items-center gap-4 p-4">
        <div
          aria-hidden
          className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl border border-accent-cyan/30 bg-bg/60"
        >
          <Image
            src="/icons/pwa/icon-192.png"
            alt=""
            width={40}
            height={40}
            className="h-10 w-10 rounded-lg"
            priority={false}
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-body font-semibold text-text">{copy.title}</p>
          <p className="text-caption text-text-muted">{copy.body}</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss install prompt"
          className={[
            "inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg",
            "border border-border bg-bg-elevated text-text-muted",
            "hover:bg-bg-subtle hover:text-text",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          ].join(" ")}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="space-y-2 border-t border-border/60 px-4 py-3">
        <Button fullWidth onClick={handleCta} disabled={prompting} aria-busy={prompting || undefined}
          iconLeft={<Download className="h-5 w-5" aria-hidden />}>
          {copy.ctaLabel}
        </Button>
        {platform === "android" && canPromptNatively && status !== "prompting" ? (
          <Button variant="ghost" size="sm" fullWidth onClick={onOpenFallback}
            iconLeft={<MoreVertical className="h-3.5 w-3.5" aria-hidden />}>
            Or install via Chrome menu
          </Button>
        ) : null}
        {copy.hint ? (
          <p className="px-1 text-caption text-text-muted">{copy.hint}</p>
        ) : null}
        {/* A plain link, not <HelpLink>: the side sheet would pull the
            whole help library into the landing page's first load. */}
        <p className="px-1 text-center text-caption">
          <Link
            href="/help/install-app"
            className="rounded-sm font-medium text-accent-cyan underline decoration-accent-cyan/40 underline-offset-2 hover:decoration-accent-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            How the app works
          </Link>
        </p>
      </div>
    </section>
  );
}
