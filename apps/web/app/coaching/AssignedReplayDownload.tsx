"use client";

import { useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { API_BASE, useOwnerRequestScope } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";

const MAX_REPLAY_BYTES = 5 * 1024 * 1024;

export function AssignedReplayDownload({ bookingId, reference, label }: { bookingId: string; reference: string; label: string }) {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const runOwned = useOwnerRequestScope(owner, getToken);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function download() {
    if (!owner || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await runOwned(owner, async (scopedToken, signal, assertCurrent) => {
        const token = await scopedToken();
        if (!token) throw new Error("Signed-in session required");
        const path = "/v1/coaching/calendar/bookings/" + encodeURIComponent(bookingId) + "/digest/replay";
        const response = await fetch(API_BASE + path, {
          method: "POST", cache: "no-store", redirect: "error", signal,
          headers: { authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify({ reference }),
        });
        const length = Number(response.headers.get("content-length"));
        if (!response.ok || !Number.isSafeInteger(length) || length < 4 || length > MAX_REPLAY_BYTES) {
          await response.body?.cancel().catch(() => {});
          throw new Error("Assigned replay unavailable");
        }
        const blob = await response.blob();
        assertCurrent();
        if (blob.size !== length) throw new Error("Incomplete replay");
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "sc2tools-replay.SC2Replay";
        document.body.appendChild(link);
        try { link.click(); } finally {
          link.remove();
          window.setTimeout(URL.revokeObjectURL.bind(URL, url), 1000);
        }
      }, 25_000);
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="secondary" className="min-h-11" loading={busy} disabled={!owner}
        aria-label={"Download assigned replay: " + label} onClick={() => void download()}>
        Download replay
      </Button>
      {failed ? <p role="alert" className="w-full text-micro text-text-muted">This assigned replay could not be downloaded. Refresh the digest or try again.</p> : null}
    </>
  );
}
