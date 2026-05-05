import type { ReactNode } from "react";

/**
 * PageHeader — title + optional eyebrow + description + actions row.
 * Server-component-safe (no client hooks).
 */
export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  align?: "left" | "center";
  className?: string;
}

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  align = "left",
  className = "",
}: PageHeaderProps) {
  return (
    <header
      className={[
        "flex flex-col gap-3 md:flex-row md:items-end md:justify-between",
        align === "center" ? "md:flex-col md:items-center md:text-center" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="space-y-1.5">
        {eyebrow ? (
          <div className="text-caption font-semibold uppercase tracking-wider text-accent-cyan">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="text-h1 font-semibold text-text">{title}</h1>
        {description ? (
          <p className="max-w-2xl text-body-lg text-text-muted">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
