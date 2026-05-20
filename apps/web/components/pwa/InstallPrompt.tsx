"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { Download, Share, Plus, X } from "lucide-react";

/**
 * InstallPrompt — mobile-only "Add to Home Screen" banner for the PWA.
 *
 *   - On Chromium / modern Android: listens for `beforeinstallprompt`,
 *     stores the event, and fires the native install dialog on tap.
 *   - On iOS Safari: no programmatic install API exists, so we show the
 *     Share → Add to Home Screen recipe instead.
 *   - Suppressed entirely on desktop, when already installed
 *     (display-mode: standalone), or after the user dismisses /
 *     installs once (persisted in localStorage with a 30-day cooldown).
 *
 * Kept as a single client component so it never ships to SSR / RSC and
 * adds zero JS to non-mobile bundles' critical path.
 */

const DISMISS_KEY = "sc2tools.pwa.installPromptDismissedAt";
const DISMISS_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: ReadonlyArray<string>;
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

type Platform = "android" | "ios" | "other";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent || "";
  if (/android/i.test(ua)) return "android";
  // iPadOS 13+ reports as Mac; gate on touch to catch it.
  const isIOS =
    /iPhone|iPad|iPod/i.test(ua) ||
    (/Macintosh/i.test(ua) && typeof document !== "undefined" && "ontouchend" in document);
  if (isIOS) return "ios";
  return "other";
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const mql = window.matchMedia?.("(display-mode: standalone)");
  if (mql?.matches) return true;
  // Safari exposes a non-standard `standalone` flag on navigator.
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

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
    window.localStorage.setItem(DISMISS_KEY, String(ts));
  } catch {
    // localStorage may be blocked (private mode, embedded contexts) —
    // the banner just reappears next visit, which is acceptable.
  }
}

export function InstallPrompt() {
  const [platform, setPlatform] = useState<Platform>("other");
  const [installed, setInstalled] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosSheet, setShowIosSheet] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setPlatform(detectPlatform());
    setInstalled(isStandalone());

    const dismissedAt = readDismissedAt();
    if (dismissedAt && Date.now() - dismissedAt < DISMISS_COOLDOWN_MS) {
      setDismissed(true);
    }
  }, []);

  useEffect(() => {
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferredPrompt(null);
      writeDismissedAt(Date.now());
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const handleInstall = useCallback(async () => {
    if (platform === "ios") {
      setShowIosSheet(true);
      return;
    }
    if (!deferredPrompt) return;
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === "accepted") {
        setInstalled(true);
      } else {
        writeDismissedAt(Date.now());
        setDismissed(true);
      }
    } catch {
      // If the browser refuses (e.g. user already saw it this session),
      // fall back to the dismissal path so we don't loop forever.
      writeDismissedAt(Date.now());
      setDismissed(true);
    } finally {
      setDeferredPrompt(null);
    }
  }, [deferredPrompt, platform]);

  const handleDismiss = useCallback(() => {
    writeDismissedAt(Date.now());
    setDismissed(true);
    setShowIosSheet(false);
  }, []);

  const visible = useMemo(() => {
    if (!mounted) return false;
    if (installed || dismissed) return false;
    if (platform === "android") return deferredPrompt !== null;
    if (platform === "ios") return true;
    return false;
  }, [mounted, installed, dismissed, platform, deferredPrompt]);

  if (!visible) return null;

  return (
    <>
      <InstallBanner platform={platform} onInstall={handleInstall} onDismiss={handleDismiss} />
      {showIosSheet ? <IosInstructionsSheet onClose={() => setShowIosSheet(false)} /> : null}
    </>
  );
}

interface InstallBannerProps {
  platform: Platform;
  onInstall: () => void;
  onDismiss: () => void;
}

function InstallBanner({ platform, onInstall, onDismiss }: InstallBannerProps) {
  const ctaLabel = platform === "ios" ? "How to install" : "Install app";
  return (
    <section
      aria-label="Install SC2 Tools as a mobile app"
      className={[
        "relative mx-auto max-w-3xl overflow-hidden rounded-2xl",
        "border border-accent-cyan/40 bg-bg-elevated/80 backdrop-blur",
        "shadow-halo-cyan",
        "md:hidden", // Mobile-only — desktop already has the agent CTAs.
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
          <p className="text-body font-semibold text-text">Install SC2 Tools</p>
          <p className="text-caption text-text-muted">
            Add to your home screen for one-tap access on the go.
          </p>
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
      <div className="border-t border-border/60 px-4 py-3">
        <button
          type="button"
          onClick={onInstall}
          className={[
            "inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg",
            "bg-accent text-body-lg font-semibold text-white",
            "hover:bg-accent-hover",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          ].join(" ")}
        >
          <Download className="h-5 w-5" aria-hidden />
          {ctaLabel}
        </button>
      </div>
    </section>
  );
}

interface IosInstructionsSheetProps {
  onClose: () => void;
}

function IosInstructionsSheet({ onClose }: IosInstructionsSheetProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ios-install-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className={[
          "w-full max-w-md rounded-t-2xl border border-border bg-bg-surface p-6 shadow-halo-cyan",
          "sm:rounded-2xl",
        ].join(" ")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="ios-install-title" className="text-h3 font-semibold text-text">
            Install SC2 Tools on iPhone
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
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
        <ol className="mt-4 space-y-3 text-body text-text">
          <li className="flex items-start gap-3">
            <span className="mt-0.5 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-accent-cyan/40 bg-accent-cyan/10 font-mono text-caption font-semibold text-accent-cyan">
              1
            </span>
            <span className="flex items-center gap-1.5">
              Tap the{" "}
              <span className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-elevated px-1.5 py-0.5 text-caption font-medium">
                <Share className="h-3.5 w-3.5" aria-hidden /> Share
              </span>{" "}
              button in Safari.
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="mt-0.5 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-accent-cyan/40 bg-accent-cyan/10 font-mono text-caption font-semibold text-accent-cyan">
              2
            </span>
            <span className="flex items-center gap-1.5">
              Choose{" "}
              <span className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-elevated px-1.5 py-0.5 text-caption font-medium">
                <Plus className="h-3.5 w-3.5" aria-hidden /> Add to Home Screen
              </span>
              .
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="mt-0.5 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-accent-cyan/40 bg-accent-cyan/10 font-mono text-caption font-semibold text-accent-cyan">
              3
            </span>
            <span>Confirm with Add — the SC2 Tools icon lands on your home screen.</span>
          </li>
        </ol>
        <button
          type="button"
          onClick={onClose}
          className={[
            "mt-6 inline-flex h-11 w-full items-center justify-center rounded-lg",
            "bg-accent text-body-lg font-semibold text-white",
            "hover:bg-accent-hover",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          ].join(" ")}
        >
          Got it
        </button>
      </div>
    </div>
  );
}
