"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { useReleaseInfo } from "@/components/onboarding/useReleaseInfo";
import { useApi } from "@/lib/clientApi";
import { useDoctor } from "../DoctorBanner";
import { setupHealthRows, type SetupMe, type SetupRow } from "./setupHealth";
import { CopySetupDiagnostics } from "./SetupDiagnostics";

export function SetupHealthCard() {
  const me = useApi<SetupMe>("/v1/me", { refreshInterval: 30_000 });
  const doctor = useDoctor();
  const release = useReleaseInfo("windows");
  const streaming = !me.data?.onboarding?.goals || me.data.onboarding.goals.includes("stream");
  const overlays = useApi<{ items: { revokedAt?: string | null; lastSeenAt?: string | null }[] }>(streaming ? "/v1/overlay-tokens" : null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const rows = setupHealthRows({ me, doctor, release, overlays, now: Math.max(now, Date.now()) });
  const warnings = rows.filter((row) => row.tone === "warn").length;
  const title = warnings ? `${warnings} thing${warnings === 1 ? "" : "s"} need${warnings === 1 ? "s" : ""} attention` : rows.some((row) => row.tone === "loading") ? "Checking your setup" : "Everything's set up";
  return <section id="setup-health" className="scroll-mt-28" aria-label="Setup health"><Card title={title} headingLevel={2}>
    <p className="mb-3 text-caption text-text-muted">Setup health · <LazyHelpLink slug="setup-health">What these checks mean</LazyHelpLink></p>
    <ul className="divide-y divide-border">{rows.map((row) => <HealthRow key={row.id} row={row} />)}</ul>
    <div className="mt-3"><CopySetupDiagnostics me={me.data} warnings={doctor.data?.warnings?.map((item) => item.id)} /></div>
  </Card></section>;
}

function HealthRow({ row }: { row: SetupRow }) {
  const Icon = row.tone === "pass" ? CheckCircle2 : row.tone === "warn" ? AlertTriangle : row.tone === "loading" ? Loader2 : Info;
  const tone = row.tone === "pass" ? "text-success" : row.tone === "warn" ? "text-warning" : "text-text-muted";
  return <li className="flex flex-wrap items-start gap-3 py-3">
    <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}${row.tone === "loading" ? " animate-spin" : ""}`} aria-hidden />
    <div className="min-w-0 flex-1"><h3 className="text-caption font-semibold">{row.title}</h3><p className="break-words text-caption text-text-muted">{row.message}</p></div>
    {row.retry ? <Button variant="ghost" size="sm" aria-label={`Retry ${row.title}`} onClick={() => { void row.retry?.(); }}>Retry</Button> : row.cta ? <Link href={row.cta.href} className="inline-flex min-h-9 items-center rounded-full px-3 text-caption text-accent underline focus-visible:ring-2 focus-visible:ring-accent">{row.cta.label}</Link> : null}
  </li>;
}
