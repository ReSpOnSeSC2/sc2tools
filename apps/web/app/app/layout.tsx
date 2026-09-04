import { Suspense, type ReactNode } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";
import { apiFetch } from "@/lib/api";
import {
  AnalyzerFrame,
  type DashboardMe,
} from "@/components/dashboard/AnalyzerFrame";
import { Card } from "@/components/ui/Card";

/**
 * /app layout — the analyzer's own concerns. The surrounding chrome
 * (rail, context bar, mobile tab bar) is mounted once in AppShell for
 * every signed-in surface, so this layout only fetches the /v1/me
 * snapshot the onboarding gate needs and wraps the routes in
 * AnalyzerFrame.
 *
 * The fetch sits in an inner async component behind Suspense so a
 * Render cold start (3–5s) paints a skeleton instead of a blank panel.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<AnalyzerSkeleton />}>
      <AnalyzerWithMe>{children}</AnalyzerWithMe>
    </Suspense>
  );
}

async function AnalyzerWithMe({ children }: { children: ReactNode }) {
  const meRes = await apiFetch<DashboardMe>("/v1/me");

  if (!meRes.ok) {
    const signedOut = meRes.status === 401 || meRes.status === 403;
    return (
      <Card className="mx-auto max-w-2xl" padded>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 rounded-full bg-danger/10 p-2 text-danger">
            <AlertTriangle className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="text-h2 font-semibold">
              {signedOut ? "Sign in again" : "Dashboard temporarily unavailable"}
            </h1>
            <p className="mt-2 text-body text-text-muted">
              {signedOut
                ? "Your sign-in session could not be confirmed. Your replay data is safe."
                : "The server is restarting or under temporary pressure. Your replay data is safe — wait a moment, then try again."}
            </p>
            <a
              href={signedOut ? "/sign-in" : "/app"}
              className="hard-press mt-5 inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full border-2 border-line bg-accent px-5 font-display text-body font-bold text-white hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              <RefreshCcw className="h-4 w-4" aria-hidden />
              {signedOut ? "Continue to sign in" : "Try again"}
            </a>
            <p className="mt-4 font-mono text-micro text-text-dim">
              Support reference: {meRes.status} {meRes.error}
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return <AnalyzerFrame me={meRes.data}>{children}</AnalyzerFrame>;
}

/** Painted inside the chrome while /v1/me is in flight. */
function AnalyzerSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading dashboard">
      <div className="h-14 animate-pulse rounded-xl border-2 border-line bg-bg-surface" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard"
          >
            <div className="h-3 w-16 animate-pulse rounded bg-bg-elevated" />
            <div className="mt-2 h-6 w-20 animate-pulse rounded bg-bg-elevated" />
          </div>
        ))}
      </div>
      <div className="h-32 animate-pulse rounded-xl border-2 border-line bg-bg-surface shadow-hard" />
      <div className="h-40 animate-pulse rounded-xl border-2 border-line bg-bg-surface shadow-hard" />
    </div>
  );
}
