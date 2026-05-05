import type { HTMLAttributes, ReactNode } from "react";

export interface SectionProps
  extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  divider?: boolean;
}

/**
 * Section — labelled content block with optional title/actions.
 * Use for grouping related content within a page; nest under PageHeader.
 */
export function Section({
  title,
  description,
  actions,
  divider = false,
  className = "",
  children,
  ...rest
}: SectionProps) {
  const showHeader = title || description || actions;
  return (
    <section
      className={[
        "space-y-4",
        divider ? "border-t border-border pt-6" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {showHeader ? (
        <header className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div className="space-y-1">
            {title ? (
              <h2 className="text-h3 font-semibold text-text">{title}</h2>
            ) : null}
            {description ? (
              <p className="text-body text-text-muted">{description}</p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          ) : null}
        </header>
      ) : null}
      <div>{children}</div>
    </section>
  );
}
