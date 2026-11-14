import Link from "next/link";
import type { ReactNode } from "react";
import { SC2PULSE_URL } from "@/lib/balance/evidence";

const LINK = "inline-flex min-h-11 items-center rounded-sm font-semibold text-accent underline focus-visible:ring-2 focus-visible:ring-accent";

export function BalanceEvidencePage({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-8">
      <header className="space-y-2">
        <Link href="/balance" prefetch={false} className={LINK}>Ladder Balance</Link>
        <h1 className="font-display text-display-lg font-bold leading-tight text-text">{title}</h1>
        <p className="max-w-prose text-body text-text-muted">{description}</p>
        <p className="text-caption text-text-muted">Data from the <a href={SC2PULSE_URL} className={LINK}>SC2Pulse API</a>.</p>
      </header>
      {children}
      <noscript><p className="text-body text-text-muted">Enable JavaScript to load ladder evidence.</p></noscript>
    </div>
  );
}
