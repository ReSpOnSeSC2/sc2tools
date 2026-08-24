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
import { useEffect, useRef } from "react";
import { API_BASE } from "@/lib/clientApi";

declare global {
  interface Window {
    LOCKER_SITE?: { apiBase: string; getToken: () => Promise<string | null> };
  }
}

export default function LockerHost() {
  const { getToken } = useAuth();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    let cancelled = false;

    async function mount() {
      const res = await fetch("/coaching/locker-site.html");
      if (!res.ok || cancelled || !hostRef.current) return;
      const text = await res.text();
      const doc = new DOMParser().parseFromString(text, "text/html");

      window.LOCKER_SITE = {
        apiBase: API_BASE,
        getToken: () => getToken(),
      };

      const host = hostRef.current;
      // Styles + static skeleton first, script last — the app's boot
      // expects #root, #state0 and #toast to exist when it runs.
      for (const node of Array.from(doc.head.children).concat(
        Array.from(doc.body.children),
      )) {
        const tag = node.tagName.toLowerCase();
        if (tag === "meta" || tag === "title") continue;
        if (tag === "script") continue; // handled below, in order
        host.appendChild(document.importNode(node, true));
      }
      for (const s of Array.from(doc.querySelectorAll("script"))) {
        const el = document.createElement("script");
        if (s.id) el.id = s.id;
        if (s.type) el.type = s.type;
        el.textContent = s.textContent;
        host.appendChild(el);
      }
    }

    void mount();
    return () => {
      cancelled = true;
    };
  }, [getToken]);

  return <div ref={hostRef} data-coaching-locker />;
}
