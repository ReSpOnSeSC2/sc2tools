"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiCall, type ClientApiError } from "@/lib/clientApi";
import type { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TEST_DURATION_MS } from "@/components/overlay/widgetLifecycle";

type PendingTest = { token: string; widget?: string };
type TestContext = {
  getToken: Parameters<typeof apiCall>[0]; toast: ReturnType<typeof useToast>["toast"];
  mounted: { current: boolean }; timer: { current: number | null };
  setTesting: (widget: string | null) => void; setPending: (pending: PendingTest | null) => void;
};

function clearTimer(context: TestContext) {
  if (context.timer.current !== null) window.clearTimeout(context.timer.current);
  context.timer.current = null;
}

async function sendTest(context: TestContext, token: string, widget?: string, force = false) {
  clearTimer(context); context.setTesting(widget || "all");
  try {
    await apiCall(context.getToken, "/v1/overlay-events/test", {
      method: "POST", body: JSON.stringify({ token, widget, ...(force ? { force: true } : {}) }),
    });
    if (!context.mounted.current) return;
    context.setPending(null);
    context.toast.success(widget ? `Sent test data to "${widget}"` : "Sent test data to every enabled widget", {
      description: "Shows sample data for about 20 s. Stop restores your real opponent and session.",
    });
    context.timer.current = window.setTimeout(() => { context.setTesting(null); context.timer.current = null; }, TEST_DURATION_MS);
  } catch (error) {
    if (!context.mounted.current) return;
    context.setTesting(null);
    if ((error as ClientApiError)?.code === "live_match") { context.setPending({ token, widget }); return; }
    context.toast.error("Couldn't fire test event", { description: (error as ClientApiError)?.message ?? "Please try again." });
  }
}

async function cancelTest(context: TestContext, token: string, widget?: string) {
  clearTimer(context); context.setTesting(null);
  try { await apiCall(context.getToken, "/v1/overlay-events/test/cancel", { method: "POST", body: JSON.stringify({ token, widget }) }); }
  catch (error) {
    if (context.mounted.current) context.toast.error("Couldn't dismiss the test", { description: (error as ClientApiError)?.message ?? "Please try again." });
    // The sample's own deadline remains a fallback when Stop cannot arrive.
  }
}

export function useOverlayTests(getToken: Parameters<typeof apiCall>[0], toast: ReturnType<typeof useToast>["toast"]) {
  const [testingWidget, setTestingWidget] = useState<string | null>(null);
  const [pendingLiveTest, setPendingLiveTest] = useState<PendingTest | null>(null);
  const timer = useRef<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    const timerRef = timer;
    mounted.current = true;
    return () => { mounted.current = false; if (timerRef.current !== null) window.clearTimeout(timerRef.current); };
  }, []);
  const context: TestContext = { getToken, toast, mounted, timer, setTesting: setTestingWidget, setPending: setPendingLiveTest };
  async function testWidget(token: string, widget?: string, force = false) {
    if (testingWidget) {
      if (testingWidget === (widget || "all")) await cancelTest(context, token, widget);
      return;
    }
    await sendTest(context, token, widget, force);
  }
  return { testingWidget, pendingLiveTest, setPendingLiveTest, testWidget };
}

export function OverlayLiveTestDialog({ pending, busy, origin = "", onClose, onSend }: {
  pending: PendingTest | null; busy: boolean; origin?: string; onClose: () => void; onSend: () => void;
}) {
  return <ConfirmDialog open={pending !== null} onClose={() => { if (!busy) onClose(); }} onConfirm={onSend}
    title="Send sample data while you're playing?" description="You're in a game — viewers will see sample data for about 20 s"
    confirmLabel="Send anyway" loading={busy} focusCancel>
    <p className="mb-3 text-body-sm text-text-muted">Stop or automatic expiry removes only the sample. Your real opponent, game and session keep updating underneath.</p>
    {pending ? <Link className="inline-flex min-h-11 items-center rounded px-2 text-accent-cyan underline focus-visible:outline focus-visible:outline-2"
      href={`${origin}/stream-studio/playground${pending.widget ? `?widget=${encodeURIComponent(pending.widget)}` : ""}`}
      target="_blank" rel="noopener noreferrer" onClick={onClose}>Preview here instead<span className="sr-only"> (opens in a new tab)</span></Link> : null}
  </ConfirmDialog>;
}
