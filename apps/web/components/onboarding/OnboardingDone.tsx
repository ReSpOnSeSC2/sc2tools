"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { ImportProgressCard } from "@/components/imports/ImportProgressCard";
import { useImportStatus } from "@/components/imports/useImportStatus";
import { useApi } from "@/lib/clientApi";
import type { PairedDevice } from "./pairingTypes";
import type { OnboardingGoal, WelcomeMe } from "./welcomeState";
import { AGENT_ONLINE_WINDOW_MS } from "@/components/dashboard/AgentUpgradeNotice";

/** The final step keeps live import progress visible while suggesting a next action. */
export function OnboardingDone({ me, goals }: { me?: WelcomeMe; goals: OnboardingGoal[] }) {
  const progress = useImportStatus();
  const devices = useApi<{ items: PairedDevice[] }>(me?.agentPaired ? "/v1/devices" : null, { refreshInterval: 5000 });
  const games = useApi<{ items: { gameId: string }[] }>(me?.games.total ? "/v1/games?limit=1" : null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const connected = devices.data?.items.find((device) => {
    const age = device.lastSeenAt ? Math.max(now, Date.now()) - Date.parse(device.lastSeenAt) : NaN;
    return age >= 0 && age < AGENT_ONLINE_WINDOW_MS;
  });
  const latest = games.data?.items[0]?.gameId;
  const improve = goals.length === 0 || goals.includes("improve");
  return <section aria-labelledby="onboarding-step-heading" className="space-y-6">
    <header className="space-y-2"><h1 id="onboarding-step-heading" tabIndex={-1} className="text-display-lg font-semibold outline-none">You&apos;re set</h1><p className="text-body-lg text-text-muted">Your account is ready. Imports can keep running while you explore.</p></header>
    {me?.agentPaired ? <p role="status" className="break-words text-caption">{connected ? `Connected: ${connected.label || connected.hostname || "Your PC"}${connected.agentVersion ? `, v${connected.agentVersion}` : ""}` : "PC paired — waiting for the app to check in"}</p> : <p className="text-caption text-text-muted">You can link a desktop app later from <Link href="/devices" className="text-accent underline">Devices</Link>.</p>}
    {devices.error ? <p role="alert" className="text-caption">Couldn&apos;t check the desktop connection. <button type="button" className="text-accent underline" onClick={() => { void devices.mutate(); }}>Retry</button></p> : null}
    {games.error ? <p role="alert" className="text-caption">Couldn&apos;t load your latest game. <button type="button" className="text-accent underline" onClick={() => { void games.mutate(); }}>Retry</button></p> : null}
    {progress.job ? <ImportProgressCard job={progress.job} active={progress.active} pct={progress.pct} etaSeconds={progress.etaSeconds} onCancelled={progress.refresh} /> : null}
    <div className="grid gap-3 sm:grid-cols-2">
      {improve ? <>
        <NextAction title={latest ? "Open your latest game" : "Open Today"} href={latest ? `/app/game/${encodeURIComponent(latest)}` : "/app?view=today"} slug="game-page">{latest ? "Review its timings, build order and map playback." : me?.games.total ? "Open Today while your latest game loads." : "Review a replay as soon as your first game arrives."}</NextAction>
        {!goals.includes("stream") ? <NextAction title="Check your identity" href="/settings?tab=profile" slug="settings-overview">Make sure your SC2 profile is linked to the right player.</NextAction> : null}
      </> : null}
      {goals.includes("stream") ? <>
        <NextAction title="Copy your first overlay URL" href="/settings?tab=overlay" slug="obs-overlay-setup">Pick a widget and add its URL to an OBS Browser Source.</NextAction>
        <NextAction title="Open the crash course" href="/stream-studio/learn#crash-course" slug="obs-auto-scene-switching">Follow the Stream Studio setup course.</NextAction>
      </> : null}
    </div>
    <Link href="/app" className="inline-flex rounded-full bg-accent px-5 py-3 font-semibold text-white focus-visible:ring-2 focus-visible:ring-accent">Open your dashboard →</Link>
  </section>;
}

function NextAction({ title, href, slug, children }: { title: string; href: string; slug: string; children: React.ReactNode }) {
  return <Card><h2 className="text-h3 font-semibold"><Link href={href} className="text-accent underline">{title}</Link></h2><p className="my-2 text-caption text-text-muted">{children}</p><LazyHelpLink slug={slug}>How it works</LazyHelpLink></Card>;
}
