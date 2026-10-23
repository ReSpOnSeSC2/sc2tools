import type { ReactNode } from "react";

/**
 * PageHeader — title + optional eyebrow + description + actions row.
 * Server-component-safe (no client hooks).
 *
 *   as="h2" + size="section": a header for one part of a page whose h1
 *   lives elsewhere, e.g. an analyzer section, where the app's context
 *   bar is the h1 (see components/analyzer/SectionHeader.tsx).
 */
export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  align?: "left" | "center";
  /** Heading level of the title. Default "h1". */
  as?: "h1" | "h2";
  /** "page" (default) or the smaller "section" type scale. */
  size?: "page" | "section";
  /** id for the description, e.g. for aria-describedby. */
  descriptionId?: string;
  className?: string;
}

const TITLE_CLASS: Record<NonNullable<PageHeaderProps["size"]>, string> = {
  page: "text-h1 font-bold text-text",
  section: "text-h3 font-bold text-text",
};

const DESCRIPTION_CLASS: Record<NonNullable<PageHeaderProps["size"]>, string> = {
  page: "max-w-2xl text-body-lg text-text-muted",
  section: "max-w-3xl text-body text-text-muted",
};

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  align = "left",
  as: Heading = "h1",
  size = "page",
  descriptionId,
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
          <div className="overline text-accent-cyan">{eyebrow}</div>
        ) : null}
        <Heading
          className={[
            TITLE_CLASS[size],
            // The accent "spine" only reads when the title is left-aligned.
            align === "center" ? "" : "title-spine",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {title}
        </Heading>
        {description ? (
          <p id={descriptionId} className={DESCRIPTION_CLASS[size]}>
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
