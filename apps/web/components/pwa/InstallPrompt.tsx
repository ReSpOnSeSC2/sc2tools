"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Image from "next/image";
import { Download, Share, Plus, MoreVertical, X } from "lucide-react";

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

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: ReadonlyArray<string>;
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

type Platform = "android" | "ios" | "other";
type InstallStatus = "idle" | "prompting" | "installed" | "cancelled" | "unavailable";

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
  const [platform, setPlatform] = useState<Platform>("other");
  const [installed, setInstalled] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosSheet, setShowIosSheet] = useState(false);
  const [showAndroidFallback, setShowAndroidFallback] = useState(false);
  const [status, setStatus] = useState<InstallStatus>("idle");
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
      // Chrome still wants us to prompt → user hasn't installed yet.
      // Clear any stale cooldown so the banner re-appears for retries.
      if (readDismissedAt()) {
        writeDismissedAt(0);
        setDismissed(false);
      }
    };
    const onInstalled = () => {
      setInstalled(true);
      setStatus("installed");
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
    if (!deferredPrompt) {
      // No live event — show the Chrome ⋮ → Install app fallback.
      setStatus("unavailable");
      setShowAndroidFallback(true);
      return;
    }
    setStatus("prompting");
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === "accepted") {
        setStatus("installed");
        setInstalled(true);
        writeDismissedAt(Date.now());
      } else {
        // User cancelled the native dialog. Leave the banner visible
        // so they can try again; no cooldown.
        setStatus("cancelled");
      }
    } catch (err) {
      // Chrome refused to open the dialog (often because the deferred
      // event was already consumed). Show the manual install path.
      if (typeof console !== "undefined") {
        console.warn("[pwa] install prompt failed:", err);
      }
      setStatus("unavailable");
      setShowAndroidFallback(true);
    } finally {
      // BeforeInstallPromptEvent.prompt() may only be called once per
      // event, so always release it after the call.
      setDeferredPrompt(null);
    }
  }, [deferredPrompt, platform]);

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
      return deferredPrompt !== null || status === "cancelled" || status === "unavailable";
    }
    if (platform === "ios") return true;
    return false;
  }, [mounted, installed, dismissed, platform, deferredPrompt, status]);

  if (!visible) return null;

  return (
    <>
      <InstallBanner
        platform={platform}
        status={status}
        canPromptNatively={deferredPrompt !== null}
        onInstall={handleInstall}
        onDismiss={handleDismiss}
        onOpenFallback={() => setShowAndroidFallback(true)}
      />
      {showIosSheet ? <IosInstructionsSheet onClose={() => setShowIosSheet(false)} /> : null}
      {showAndroidFallback ? (
        <AndroidFallbackSheet onClose={() => setShowAndroidFallback(false)} />
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
        <button
          type="button"
          onClick={handleCta}
          disabled={prompting}
          aria-busy={prompting}
          className={[
            "inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg",
            "bg-accent text-body-lg font-semibold text-white",
            "hover:bg-accent-hover",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
            "disabled:cursor-not-allowed disabled:opacity-70",
          ].join(" ")}
        >
          <Download className="h-5 w-5" aria-hidden />
          {copy.ctaLabel}
        </button>
        {platform === "android" && canPromptNatively && status !== "prompting" ? (
          <button
            type="button"
            onClick={onOpenFallback}
            className={[
              "inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg",
              "text-caption font-medium text-text-muted",
              "hover:bg-bg-subtle hover:text-text",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
            ].join(" ")}
          >
            <MoreVertical className="h-3.5 w-3.5" aria-hidden />
            Or install via Chrome menu
          </button>
        ) : null}
        {copy.hint ? (
          <p className="px-1 text-caption text-text-muted">{copy.hint}</p>
        ) : null}
      </div>
    </section>
  );
}

interface IosInstructionsSheetProps {
  onClose: () => void;
}

function useSheetEffects(onClose: () => void) {
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
}

interface InstructionStep {
  body: ReactNode;
}

interface InstructionsSheetProps {
  title: string;
  titleId: string;
  steps: ReadonlyArray<InstructionStep>;
  footnote?: ReactNode;
  onClose: () => void;
}

function InstructionsSheet({ title, titleId, steps, footnote, onClose }: InstructionsSheetProps) {
  useSheetEffects(onClose);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
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
          <h2 id={titleId} className="text-h3 font-semibold text-text">
            {title}
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
          {steps.map((step, index) => (
            <li key={index} className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-accent-cyan/40 bg-accent-cyan/10 font-mono text-caption font-semibold text-accent-cyan">
                {index + 1}
              </span>
              <span className="flex-1">{step.body}</span>
            </li>
          ))}
        </ol>
        {footnote ? (
          <p className="mt-4 rounded-lg border border-border/60 bg-bg-elevated/60 p-3 text-caption text-text-muted">
            {footnote}
          </p>
        ) : null}
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

function Keycap({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-elevated px-1.5 py-0.5 text-caption font-medium">
      {children}
    </span>
  );
}

function IosInstructionsSheet({ onClose }: IosInstructionsSheetProps) {
  const steps: ReadonlyArray<InstructionStep> = [
    {
      body: (
        <span className="flex flex-wrap items-center gap-1.5">
          Tap the{" "}
          <Keycap>
            <Share className="h-3.5 w-3.5" aria-hidden /> Share
          </Keycap>{" "}
          button in Safari.
        </span>
      ),
    },
    {
      body: (
        <span className="flex flex-wrap items-center gap-1.5">
          Choose{" "}
          <Keycap>
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add to Home Screen
          </Keycap>
          .
        </span>
      ),
    },
    {
      body: <span>Confirm with Add — the SC2 Tools icon lands on your home screen.</span>,
    },
  ];
  return (
    <InstructionsSheet
      title="Install SC2 Tools on iPhone"
      titleId="ios-install-title"
      steps={steps}
      onClose={onClose}
    />
  );
}

interface AndroidFallbackSheetProps {
  onClose: () => void;
}

function AndroidFallbackSheet({ onClose }: AndroidFallbackSheetProps) {
  const steps: ReadonlyArray<InstructionStep> = [
    {
      body: (
        <span className="flex flex-wrap items-center gap-1.5">
          Tap the{" "}
          <Keycap>
            <MoreVertical className="h-3.5 w-3.5" aria-hidden /> menu
          </Keycap>{" "}
          in the top-right of Chrome.
        </span>
      ),
    },
    {
      body: (
        <span className="flex flex-wrap items-center gap-1.5">
          Choose <Keycap>Install app</Keycap> (or <Keycap>Add to Home screen</Keycap> on
          older Chrome).
        </span>
      ),
    },
    {
      body: <span>Tap Install — SC2 Tools lands on your home screen and app drawer.</span>,
    },
  ];
  return (
    <InstructionsSheet
      title="Install SC2 Tools on Android"
      titleId="android-install-title"
      steps={steps}
      footnote={
        <>
          If you don&apos;t see &ldquo;Install app&rdquo; in the menu, your phone may already
          have SC2 Tools installed — check your home screen and app drawer.
        </>
      }
      onClose={onClose}
    />
  );
}
