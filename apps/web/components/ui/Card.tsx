"use client";

import type { ReactNode } from "react";

type CardProps = {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
};

export function Card({ title, right, children, className = "" }: CardProps) {
  return (
    <section className={`card overflow-hidden ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold text-text">{title}</h3>
          {right ? <div>{right}</div> : null}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-elevated p-3">
      <div className="text-[10px] uppercase tracking-wider text-text-dim">
        {label}
      </div>
      <div
        className="mt-1 text-xl font-semibold tabular-nums"
        style={color ? { color } : undefined}
      >
        {value}
      </div>
    </div>
  );
}

export function EmptyState({
  title = "No data",
  sub,
}: {
  title?: string;
  sub?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-10 text-center">
      <div className="text-sm font-medium text-text-muted">{title}</div>
      {sub ? <div className="text-xs text-text-dim">{sub}</div> : null}
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="card divide-y divide-border">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex animate-pulse gap-4 p-4">
          <div className="h-4 w-32 rounded bg-bg-elevated" />
          <div className="h-4 w-12 rounded bg-bg-elevated" />
          <div className="h-4 w-12 rounded bg-bg-elevated" />
          <div className="h-4 w-24 rounded bg-bg-elevated" />
        </div>
      ))}
    </div>
  );
}

export function WrBar({
  wins,
  losses,
}: {
  wins: number;
  losses: number;
}) {
  const total = wins + losses;
  const wp = total > 0 ? (wins / total) * 100 : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded bg-bg-elevated">
      <div
        className="h-full"
        style={{
          width: `${wp}%`,
          background: "#3ec07a",
        }}
      />
    </div>
  );
}
