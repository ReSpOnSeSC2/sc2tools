import { Suspense, type ReactNode } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { AppChrome, type DashboardMe } from "@/components/chrome/AppChrome";
import { Card } from "@/components/ui/Card";

/**
 * /app layout — mounts the application chrome (rail, context bar,
 * mobile tab bar) around every app route: Today, the analyzer
 * sections, opponent dossiers, and the per-game replay analysis.
 *
 * The /v1/me fetch lives in an inner async component behind Suspense
 * so a Render cold start (3–5s) paints the shell skeleton instantly
 * instead of a blank page. The onboarding funnel mutates the snapshot
 * (pairing completes, first games land); AppChrome re-runs the fetch
 * via router.refresh() when games:changed arrives during that window.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<AppShellSkeleton />}>
      <AppWithMe>{children}</AppWithMe>
    </Suspense>
  );
}

async function AppWithMe({ children }: { children: ReactNode }) {
  const meRes = await apiFetch<DashboardMe>("/v1/me");

  if (!meRes.ok) {
    const signedOut = meRes.status === 401 || meRes.status === 403;
    return (
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
        <Card className="mx-auto max-w-2xl" padded>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 rounded-full bg-danger/10 p-2 text-danger">
              <AlertTriangle className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h1 className="text-h2 font-semibold">
                {signedOut
                  ? "Sign in again"
                  : "Dashboard temporarily unavailable"}
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
      </main>
    );
  }

  return <AppChrome me={meRes.data}>{children}</AppChrome>;
}

/**
 * Chrome-shaped skeleton painted while /v1/me is in flight — the rail
 * strip, the context bar, and a stack of content placeholders. Streams
 * instantly on a cold start so the app never opens as a blank page.
 */
function AppShellSkeleton() {
  return (
    <div
      className="flex min-h-dvh"
      aria-busy="true"
      aria-label="Loading dashboard"
    >
      <div className="hidden w-16 shrink-0 border-r-2 border-border bg-bg-surface px-2 py-3 md:block">
        <div className="mx-auto h-8 w-8 animate-pulse rounded-full bg-bg-elevated" />
        <div className="mt-4 space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="mx-auto h-8 w-10 animate-pulse rounded-lg bg-bg-elevated"
            />
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b-2 border-border">
          <div className="mx-auto flex h-12 w-full max-w-[1680px] items-center gap-3 px-4 sm:px-6 lg:px-8">
            <div className="h-5 w-28 animate-pulse rounded bg-bg-elevated" />
            <div className="ml-auto h-8 w-8 animate-pulse rounded-full bg-bg-elevated" />
          </div>
        </div>
        <div className="mx-auto w-full max-w-[1680px] flex-1 space-y-5 px-4 pb-24 pt-5 sm:px-6 md:pb-10 lg:px-8">
          <div className="h-14 animate-pulse rounded-xl border-2 border-line bg-bg-surface" />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard"
              >
                <div className="h-3 w-16 animate-pulse rounded bg-bg-elevated" />
                <div className="mt-2 h-6 w-20 animate-pulse rounded bg-bg-elevated" />
              </div>
            ))}
          </div>
          <div className="rounded-xl border-2 border-line bg-bg-surface shadow-hard">
            <div className="divide-y divide-border">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex animate-pulse gap-4 p-4">
                  <div className="h-4 w-32 rounded bg-bg-elevated" />
                  <div className="h-4 w-12 rounded bg-bg-elevated" />
                  <div className="h-4 w-12 rounded bg-bg-elevated" />
                  <div className="h-4 w-24 rounded bg-bg-elevated" />
                  <div className="ml-auto h-4 w-16 rounded bg-bg-elevated" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
