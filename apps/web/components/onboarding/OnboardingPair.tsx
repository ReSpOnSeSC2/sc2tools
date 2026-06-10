"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, XCircle } from "lucide-react";
import { useAuth } from "@clerk/nextjs";
import { apiCall } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";

/**
 * Step 3 — Pair. The AGENT generates the 6-digit code (it appears in
 * the agent's window and tray the first time it runs unpaired); the
 * signed-in user types it here and we POST
 * `/v1/device-pairings/claim` to bind the device to the account. The
 * agent polls the code and picks the token up within seconds.
 *
 * (The flow is agent → web. An earlier version of this step minted a
 * code on the web and told users to "paste it into the agent" — the
 * agent has no such prompt, so nobody could complete it.)
 *
 * ``onContinue`` (the wizard's next-step advance) takes precedence
 * over the legacy "Open your dashboard" CTA when provided, so pairing
 * flows into the import step instead of ending the wizard early.
 */
export function OnboardingPair({
  onContinue,
}: {
  onContinue?: () => void;
} = {}) {
  const router = useRouter();
  const { getToken } = useAuth();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [paired, setPaired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClaim(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      setError("Enter the 6-digit code shown in the agent's window.");
      return;
    }
    setSubmitting(true);
    try {
      await apiCall(getToken, "/v1/device-pairings/claim", {
        method: "POST",
        body: JSON.stringify({ code: trimmed }),
      });
      setPaired(true);
    } catch (err: unknown) {
      const m =
        typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : "Pairing failed — generate a fresh code by restarting the agent.";
      setError(m);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-labelledby="onboarding-step-heading" className="space-y-8">
      <header className="space-y-2">
        <h1
          id="onboarding-step-heading"
          tabIndex={-1}
          className="text-display-lg font-semibold tracking-tight text-text outline-none"
        >
          Pair this machine
        </h1>
        <p className="text-body-lg text-text-muted">
          Run the agent on your gaming PC — it shows a 6-digit code in
          its window the first time it starts. Type that code here to
          link it to your account.
        </p>
      </header>

      {paired ? (
        <PairReady />
      ) : (
        <form onSubmit={onClaim} className="space-y-4">
          <div className="flex flex-col items-center gap-4 rounded-2xl border border-accent-cyan/30 bg-bg-surface px-6 py-10 text-center shadow-halo-cyan">
            <label
              htmlFor="onboarding-pair-code"
              className="text-caption font-semibold uppercase tracking-wider text-text-muted"
            >
              Code from the agent
            </label>
            <input
              id="onboarding-pair-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              maxLength={6}
              className="h-14 w-56 rounded-lg border border-border bg-bg-elevated text-center font-mono text-[28px] font-bold tracking-[0.3em] text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
            <Button type="submit" size="lg" disabled={submitting} loading={submitting}>
              Pair device
            </Button>
            {error ? (
              <p
                role="alert"
                className="inline-flex items-center gap-1.5 text-caption text-danger"
              >
                <XCircle className="h-4 w-4 flex-shrink-0" aria-hidden />
                {error}
              </p>
            ) : null}
          </div>

          <ol className="ml-5 list-decimal space-y-1 text-caption text-text-muted">
            <li>Run the agent on your gaming PC.</li>
            <li>It displays a 6-digit pairing code — type it above.</li>
            <li>
              No code showing? The agent is already paired — manage it on
              the{" "}
              <Link href="/devices" className="text-accent hover:text-accent-hover">
                Devices page
              </Link>
              .
            </li>
          </ol>
        </form>
      )}

      {paired ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
          {onContinue ? (
            <Button size="lg" onClick={onContinue} aria-label="Continue to import">
              Continue →
            </Button>
          ) : (
            <Button
              size="lg"
              onClick={() => router.push("/app")}
              aria-label="Open the dashboard"
            >
              Open your dashboard →
            </Button>
          )}
        </div>
      ) : null}
    </section>
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
      <CheckCircle2 className="h-10 w-10 text-success" aria-hidden />
      <h2 className="text-h3 font-semibold text-text">Paired successfully</h2>
      <p className="max-w-md text-caption text-text-muted">
        The agent picks the link up within a few seconds. Play a ranked
        game — your dashboard fills in right after the score screen.
      </p>
      <style>{`@keyframes haloPulseSubtle{0%,100%{opacity:.4}50%{opacity:.7}}`}</style>
    </div>
  );
}
