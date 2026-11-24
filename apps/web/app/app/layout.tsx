import { Suspense, type ReactNode } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";
import { apiFetch } from "@/lib/api";
import {
  AnalyzerFrame,
  type DashboardMe,
} from "@/components/dashboard/AnalyzerFrame";
import { Card } from "@/components/ui/Card";
import { buttonClassName } from "@/components/ui/buttonStyles";

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
      <Card variant="elevated" className="mx-auto max-w-2xl" padded>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 rounded-full bg-danger/10 p-2 text-danger">
            <AlertTriangle className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="font-display text-h2 font-bold tracking-tight">
              {signedOut ? "Sign in again" : "Dashboard temporarily unavailable"}
            </h1>
            <p className="mt-2 text-body text-text-muted">
              {signedOut
                ? "Your sign-in session could not be confirmed. Your replay data is safe."
                : "The server is restarting or under temporary pressure. Your replay data is safe — wait a moment, then try again."}
            </p>
            <a
              href={signedOut ? "/sign-in" : "/app"}
              className={buttonClassName({ variant: "primary", className: "mt-5" })}
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
      <div className="skeleton-shimmer h-14 rounded-2xl border border-line" />
      {/* Same grid as DashboardKpiStrip: the lead card spans both
          columns on phones, so nothing shifts when the cards arrive. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className={[
              "rounded-2xl border border-line bg-bg-surface surface-sheen p-4 shadow-card",
              i === 0 ? "col-span-2 lg:col-span-1" : "",
            ].join(" ")}
          >
            <div className="skeleton-shimmer h-3 w-16 rounded-full" />
            <div className="skeleton-shimmer mt-3 h-8 w-24 rounded-lg" />
          </div>
        ))}
      </div>
      <div className="skeleton-shimmer h-32 rounded-2xl border border-line" />
      <div className="skeleton-shimmer h-40 rounded-2xl border border-line" />
    </div>
  );
}
