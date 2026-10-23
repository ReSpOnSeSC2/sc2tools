"use client";

// Mounts the Locker app (a self-contained vanilla-JS page kept in
// coaching/locker_app_template.html and built to
// public/coaching/locker-site.html) and hands it the site bridge:
// window.LOCKER_SITE = { apiBase, getToken }.
//
// The same template powers the standalone artifact build; the bridge's
// presence is what flips it into live-API mode (Clerk identity, Mongo
// state, live user directory, per-account agent games). Keeping it a
// runtime-injected asset means the Locker iterates without touching
// the Next bundle, and the coaching UI stays out of the main chunks.

import { useAuth } from "@clerk/nextjs";
import { useEffect, useRef, useState } from "react";
import { API_BASE } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

declare global {
  interface Window {
    LOCKER_SITE?: { apiBase: string; getToken: () => Promise<string | null> };
  }
}

// The classic Locker bundle declares top-level lexical bindings used by its
// inline handlers. Those bindings cannot be declared twice in one document.
// Keep one persistent inner host in the document for the page lifetime and
// move it into a hidden parking node across route unmounts. Remaining in the
// document also keeps async boot callbacks and the theme observer valid.
let persistentLockerRoot: HTMLDivElement | null = null;
let activeMountHost: HTMLDivElement | null = null;
let lockerInitialized = false;

function lockerParkingNode() {
  let parking = document.getElementById("coaching-locker-parking") as HTMLDivElement | null;
  if (!parking) {
    parking = document.createElement("div");
    parking.id = "coaching-locker-parking";
    parking.hidden = true;
    parking.setAttribute("aria-hidden", "true");
    document.body.appendChild(parking);
  }
  return parking;
}

function parkLocker(host: HTMLDivElement) {
  if (!persistentLockerRoot || activeMountHost !== host) return;
  lockerParkingNode().appendChild(persistentLockerRoot);
  activeMountHost = null;
}

export default function LockerHost() {
  const { getToken } = useAuth();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;

    if (!persistentLockerRoot) {
      persistentLockerRoot = document.createElement("div");
      persistentLockerRoot.setAttribute("data-coaching-locker", "");
    }
    const lockerRoot = persistentLockerRoot;
    host.appendChild(lockerRoot);
    activeMountHost = host;

    window.LOCKER_SITE = {
      apiBase: API_BASE,
      getToken: () => getToken(),
    };

    if (lockerInitialized) {
      setStatus("ready");
      return () => parkLocker(host);
    }

    async function mount(target: HTMLDivElement) {
      setStatus("loading");
      try {
      const res = await fetch("/coaching/locker-site.html");
      if (cancelled) return;
      if (!res.ok) throw new Error("Locker fetch failed");
      const text = await res.text();
      if (cancelled || !hostRef.current) return;
      const doc = new DOMParser().parseFromString(text, "text/html");
      target.replaceChildren();

      // Styles + static skeleton first, script last — the app's boot
      // expects #root, #state0 and #toast to exist when it runs.
      for (const node of Array.from(doc.head.children).concat(
        Array.from(doc.body.children),
      )) {
        const tag = node.tagName.toLowerCase();
        if (tag === "meta" || tag === "title") continue;
        if (tag === "script") continue; // handled below, in order
        target.appendChild(document.importNode(node, true));
      }
      for (const s of Array.from(doc.querySelectorAll("script"))) {
        const el = document.createElement("script");
        if (s.id) el.id = s.id;
        if (s.type) el.type = s.type;
        el.textContent = s.textContent;
        target.appendChild(el);
      }
      lockerInitialized = true;
      activeMountHost = host;
      setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    }

    void mount(lockerRoot);
    return () => {
      cancelled = true;
      parkLocker(host);
    };
  }, [getToken, attempt]);

  return <>
    {status === "loading" ? <div role="region" aria-busy="true" aria-label="Loading the Locker…" className="space-y-4"><div className="h-12 animate-pulse rounded-xl bg-bg-elevated" /><div className="grid gap-4 sm:grid-cols-2"><div className="h-64 animate-pulse rounded-xl bg-bg-elevated" /><div className="h-64 animate-pulse rounded-xl bg-bg-elevated" /></div></div> : null}
    {status === "error" ? <Card><h2 className="text-h4 font-semibold text-text">The Locker couldn't load</h2><p className="mt-2 text-caption text-text-muted">Your coaching data is safe. Check your connection and try again.</p><Button className="mt-4" onClick={() => setAttempt((value) => value + 1)}>Try again</Button></Card> : null}
    <div ref={hostRef} hidden={status !== "ready"} />
  </>;
}
