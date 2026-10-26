"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CHECKING, INITIAL_CHECK, checkPublicReachability, publicApiPingUrl, type CheckResult, type Reachability } from "./reachability";

type Service = "website" | "api";
type Results = Record<Service, CheckResult>;
const SERVICES = [{ id: "website", name: "Website" }, { id: "api", name: "API" }] as const;
const LABELS: Record<Reachability, string> = { unknown: "Unknown", checking: "Checking…", reachable: "Reachable", unavailable: "Unavailable" };

export function StatusChecks() {
  const [results, setResults] = useState<Results>({ website: INITIAL_CHECK, api: INITIAL_CHECK });
  const scope = useRef({ active: false, mount: 0, run: 0, controller: null as AbortController | null });
  const refresh = useCallback(() => {
    const current = scope.current;
    if (!current.active) return;
    current.controller?.abort();
    const controller = new AbortController(), run = ++current.run;
    current.controller = controller;
    setResults({ website: CHECKING, api: CHECKING });
    const urls = { website: "/api/ping", api: publicApiPingUrl(process.env.NEXT_PUBLIC_API_BASE, window.location.origin) };
    for (const { id } of SERVICES) void checkPublicReachability(urls[id], controller.signal).then(result => {
      if (current.active && current.run === run && !controller.signal.aborted) setResults(previous => ({ ...previous, [id]: result }));
    }).catch(() => { /* Retired checks are intentionally silent. */ });
  }, []);

  useEffect(() => {
    const current = scope.current, mount = ++current.mount;
    current.active = true;
    // StrictMode replays setup before this microtask. Only its current mount
    // starts requests; cleanup still fences an actual navigation immediately.
    queueMicrotask(() => { if (current.active && current.mount === mount) refresh(); });
    return () => { current.active = false; current.mount++; current.run++; current.controller?.abort(); };
  }, [refresh]);

  const checking = SERVICES.some(({ id }) => results[id].state === "checking");
  return <section aria-labelledby="current-checks-title" className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="current-checks-title" className="font-display text-h3 font-semibold text-text">Current checks</h2>
      <Button variant="secondary" loading={checking} onClick={refresh} aria-describedby="status-check-scope">Refresh checks</Button>
    </div>
    <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{SERVICES.map(({ id, name }) => `${name}: ${LABELS[results[id].state]}`).join(". ")}</p>
    <div className="grid min-w-0 gap-4 sm:grid-cols-2">
      {SERVICES.map(({ id, name }) => <ServiceCard key={id} id={id} name={name} result={results[id]} />)}
    </div>
    <p id="status-check-scope" className="text-caption text-text-muted">Checks run when you open this page and when you select Refresh checks. Each result reflects a request from this browser; replay processing and other features can have separate issues.</p>
  </section>;
}

function ServiceCard({ id, name, result }: { id: Service; name: string; result: CheckResult }) {
  return <Card aria-labelledby={`check-${id}`} padded={false}>
    <Card.Header className="flex-wrap gap-3">
      <h3 id={`check-${id}`} className="font-display text-h3 font-semibold text-text">{name}</h3>
      <p className="rounded-full border border-border-strong bg-bg-elevated px-3 py-1 text-caption font-semibold text-text">{LABELS[result.state]}</p>
    </Card.Header>
    <Card.Body className="space-y-3">
      <p className="text-body text-text">{result.message}</p>
      <p className="text-caption text-text-muted">{result.checkedAt ? <>Checked <time dateTime={result.checkedAt}>{new Date(result.checkedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" })}</time></> : result.state === "checking" ? "Check in progress." : "Not checked yet."}</p>
    </Card.Body>
  </Card>;
}
