"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { COOKIE_SETTINGS_EVENT, isAnalyticsConfigured, readConsent, setConsent, subscribeConsent, withdrawConsent } from "@/lib/analytics/consent";

export function CookieBanner() {
  const consent = useSyncExternalStore(subscribeConsent, readConsent, () => "unset" as const);
  const [reopened, setReopened] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  function close() { setReopened(false); if (trigger.current?.isConnected) trigger.current.focus(); }
  useEffect(() => {
    const open = () => { trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setReopened(true); };
    window.addEventListener(COOKIE_SETTINGS_EVENT, open);
    return () => window.removeEventListener(COOKIE_SETTINGS_EVENT, open);
  }, []);
  useEffect(() => { if (reopened) panel.current?.focus(); }, [reopened]);
  useEffect(() => {
    if (!reopened) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setReopened(false); if (trigger.current?.isConnected) trigger.current.focus(); }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [reopened]);
  if (!isAnalyticsConfigured() || (consent !== "unset" && !reopened)) return null;
  function choose(allow: boolean) { if (allow) setConsent("granted"); else withdrawConsent(); close(); }
  return <div ref={panel} data-cookie-banner role="dialog" aria-labelledby="cookie-title" aria-describedby="cookie-body" tabIndex={-1}
    onKeyDown={(event) => { if (event.key === "Escape" && reopened) { event.preventDefault(); close(); } }}
    className="fixed inset-x-0 bottom-above-chrome z-banner px-3 focus:outline-none sm:left-auto sm:right-4 sm:max-w-md sm:px-0">
    <div className="rounded-xl border-2 border-border bg-bg-surface p-4 shadow-hard">
      <div className="flex items-center justify-between gap-3"><h2 id="cookie-title" className="text-body font-semibold text-text">{reopened ? "Cookie settings" : "Cookies & analytics"}</h2>
        {reopened ? <button type="button" aria-label="Close cookie settings" onClick={close} className="grid h-11 w-11 place-items-center rounded focus-visible:ring-2 focus-visible:ring-accent"><X aria-hidden className="h-4 w-4" /></button> : null}</div>
      {reopened ? <p role="status" className="text-caption text-text-muted">Analytics is currently {consent === "granted" ? "on" : "off"}</p> : null}
      <p id="cookie-body" className="mt-2 text-caption text-text-muted">Essential cookies keep you signed in and count each browser once in players online. With your OK, Google Analytics shows us which features get used. No ads, no data selling. <Link href="/legal/privacy" className="text-accent underline hover:text-accent-hover">Privacy Policy</Link>.</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:justify-end"><Button size="md" variant="secondary" onClick={() => choose(false)}>{reopened ? "Turn off analytics" : "Reject"}</Button><Button size="md" onClick={() => choose(true)}>{reopened ? "Allow analytics" : "Accept"}</Button></div>
    </div>
  </div>;
}
