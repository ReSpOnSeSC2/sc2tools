"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { captureException } from "@/lib/sentry";

export default function GamePageError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => { void captureException(error); }, [error]);
  return <Card title="This game page hit a problem">
    <p className="mb-4 text-caption text-text-muted">Your replay is safe. Try loading this page again.</p>
    <div className="flex flex-wrap items-center gap-4"><Button onClick={reset}>Try again</Button>
      <Link href="/app">Back to dashboard</Link></div>
  </Card>;
}
