import { apiFetch } from "@/lib/api";
import { DashboardLayout } from "@/components/dashboard/DashboardLayout";
import { Card } from "@/components/ui/Card";
import { opponentContextFromQuery } from "@/lib/opponentNavigation";
import { AlertTriangle, RefreshCcw } from "lucide-react";

type Me = {
  userId: string;
  source: string;
  games: { total: number; latest: string | null };
  agentPaired: boolean;
  agentVersion?: string | null;
  agentLastSeenAt?: string | null;
  onboarding?: { downloadStartedAt?: string; dismissedAt?: string } | null;
};

export default async function AnalyzerHome({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const opponentContext = opponentContextFromQuery(query);
  const meRes = await apiFetch<Me>("/v1/me");

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

  return (
    <DashboardLayout
      me={meRes.data}
      initialOpponentId={opponentContext?.pulseId ?? null}
    />
  );
}
