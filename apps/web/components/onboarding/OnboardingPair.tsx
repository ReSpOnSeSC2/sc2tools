"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Copy,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { usePairCode } from "./usePairCode";

/**
 * Step 3 — Pair. Mints a code via `POST /v1/device-pairings/start`,
 * polls `GET /v1/device-pairings/:code` until the agent claims it.
 *
 * UI states:
 *   - idle/starting: skeleton + "Generating code…"
 *   - waiting:       big code chip + animated cyan halo + paste hint
 *   - ready:         cyan pulse + check + "Open dashboard" CTA
 *   - expired/error: callout + "Generate new code" retry
 */
export function OnboardingPair() {
  const router = useRouter();
  const pair = usePairCode();
  const [copied, setCopied] = useState(false);

  // Auto-start the handshake when the user lands on this step.
  useEffect(() => {
    if (pair.status === "idle") void pair.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function copyCode() {
    if (!pair.code) return;
    try {
      await navigator.clipboard.writeText(pair.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — user can select the chip manually */
    }
  }

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
          Pair this machine
        </h1>
        <p className="text-body-lg text-text-muted">
          Run the agent, paste this code into the prompt, and we&apos;ll
          link it to your account. We&apos;ll keep watching here until it
          connects.
        </p>
      </header>

      <PairBody pair={pair} copied={copied} onCopy={copyCode} />

      {pair.status === "ready" ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
          <Button
            size="lg"
            onClick={() => router.push("/app")}
            aria-label="Open the dashboard"
          >
            Open your dashboard →
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function PairBody({
  pair,
  copied,
  onCopy,
}: {
  pair: ReturnType<typeof usePairCode>;
  copied: boolean;
  onCopy: () => void;
}) {
  if (pair.status === "starting" || pair.status === "idle") {
    return <PairLoading />;
  }
  if (pair.status === "error" || pair.status === "expired") {
    return (
      <PairFailure
        message={
          pair.error ||
          (pair.status === "expired"
            ? "That code expired before the agent claimed it."
            : "Couldn't generate a pairing code.")
        }
        onRetry={pair.retry}
      />
    );
  }
  if (pair.status === "ready") {
    return <PairReady />;
  }
  // status === "waiting"
  return (
    <PairWaiting code={pair.code || ""} copied={copied} onCopy={onCopy} />
  );
}

function PairLoading() {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-3 rounded-xl border border-border bg-bg-surface px-6 py-12 text-body text-text-muted"
    >
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
      Generating a pairing code…
    </div>
  );
}

function PairWaiting({
  code,
  copied,
  onCopy,
}: {
  code: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="relative isolate flex flex-col items-center justify-center rounded-2xl border border-accent-cyan/30 bg-bg-surface px-6 py-10 text-center shadow-halo-cyan sm:py-14">
        {/* Animated cyan halo while waiting */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 rounded-2xl"
          style={{
            background:
              "radial-gradient(ellipse 65% 65% at 50% 50%, var(--halo-cyan) 0%, transparent 65%)",
            animation: "haloPulse 2.4s ease-in-out infinite",
          }}
        />
        <p className="text-caption font-semibold uppercase tracking-wider text-text-muted">
          Pairing code
        </p>
        <code
          className="mt-3 select-all font-mono text-[40px] font-bold tracking-[0.3em] text-accent-cyan sm:text-[56px]"
          style={{
            textShadow:
              "0 0 24px rgb(var(--accent-cyan) / 0.6), 0 0 4px rgb(var(--accent-cyan) / 0.4)",
          }}
          aria-live="polite"
          aria-label={`Pairing code ${code.split("").join(" ")}`}
        >
          {code || "------"}
        </code>

        <button
          type="button"
          onClick={onCopy}
          aria-label="Copy pairing code"
          className="mt-5 inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-border bg-bg-elevated px-3 text-caption text-text-muted hover:border-border-strong hover:bg-bg-subtle hover:text-text"
        >
          <Copy className="h-3.5 w-3.5" aria-hidden />
          {copied ? "Copied" : "Copy code"}
        </button>

        <p
          className="mt-6 flex items-center gap-2 text-caption text-text-muted"
          aria-live="polite"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Waiting for the agent to claim it…
        </p>
      </div>

      <ol className="ml-5 list-decimal space-y-1 text-caption text-text-muted">
        <li>Run the agent on your gaming PC.</li>
        <li>
          When prompted, paste <strong className="text-text">{code || "the code above"}</strong>.
        </li>
        <li>This page advances automatically when the link is live.</li>
      </ol>

      <style>{`@keyframes haloPulse{0%,100%{opacity:.55;transform:scale(.98)}50%{opacity:1;transform:scale(1.02)}}`}</style>
    </div>
  );
}

function PairReady() {
  return (
    <div className="relative isolate flex flex-col items-center justify-center gap-3 rounded-2xl border border-success/40 bg-bg-surface px-6 py-12 text-center">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 rounded-2xl"
        style={{
          background:
            "radial-gradient(ellipse 65% 65% at 50% 50%, var(--halo-cyan) 0%, transparent 65%)",
          animation: "haloPulseSubtle 3s ease-in-out infinite",
        }}
      />
      <CheckCircle2
        className="h-10 w-10 text-success"
        aria-hidden
      />
      <h2 className="text-h3 font-semibold text-text">
        Paired successfully
      </h2>
      <p className="max-w-md text-caption text-text-muted">
        Your machine is linked. Play a ranked game — your dashboard
        will fill in within a few seconds of the score screen.
      </p>
      <style>{`@keyframes haloPulseSubtle{0%,100%{opacity:.4}50%{opacity:.7}}`}</style>
    </div>
  );
}

function PairFailure({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => Promise<void>;
}) {
  return (
    <div
      role="alert"
      className="space-y-4 rounded-xl border border-danger/40 bg-danger/5 p-5 sm:p-6"
    >
      <header className="flex items-start gap-2">
        <XCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-danger" aria-hidden />
        <div className="min-w-0 space-y-1">
          <h3 className="text-body-lg font-semibold text-text">
            Pairing didn&apos;t complete
          </h3>
          <p className="text-caption text-text-muted">{message}</p>
        </div>
      </header>
      <Button
        variant="secondary"
        iconLeft={<RefreshCw className="h-4 w-4" aria-hidden />}
        onClick={() => void onRetry()}
      >
        Generate new code
      </Button>
    </div>
  );
}
