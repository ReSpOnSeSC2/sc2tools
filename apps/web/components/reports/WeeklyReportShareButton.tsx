"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import type { WeeklyReport } from "@/lib/reports";

export function WeeklyReportShareButton({ report }: { report: WeeklyReport }) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean } | null>(null);

  async function share() {
    setBusy(true);
    setFeedback(null);
    try {
      const { shareWeeklyReport } = await import("@/lib/weeklyReportImage");
      const status = await shareWeeklyReport(report);
      if (status) setFeedback({ text: status });
    } catch {
      setFeedback({ text: "Couldn’t make the weekly report image. Try again.", error: true });
    } finally {
      setBusy(false);
    }
  }

  return <>
    <Button variant="secondary" size="sm" className="min-h-11" loading={busy} onClick={() => void share()}>Share image</Button>
    {feedback ? <p className={feedback.error ? "self-center text-caption text-danger" : "self-center text-caption text-text-muted"} role={feedback.error ? "alert" : "status"}>{feedback.text}</p> : null}
  </>;
}
