import type { SectionProps } from "@/components/ui/Section";
import { GUIDE_SECTION_ANCHOR_CLASS } from "./guideUi";
import { GuideSectionCopy } from "./GuideSectionCopy";

/** Keep heading copy controls beside their title, including on narrow phones. */
export function GuideSection({ id, title, description, actions, divider = false, className = "", children, ...props }: SectionProps) {
  return (
    <section {...props} id={id} className={`group/guide space-y-4 ${GUIDE_SECTION_ANCHOR_CLASS} ${divider ? "border-t border-border pt-6" : ""} ${className}`}>
      {title || description || actions ? (
        <header className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            {title ? <div className="flex min-h-11 items-center justify-between gap-2"><h2 className="title-spine min-w-0 text-h3 font-bold text-text">{title}</h2>{id && typeof title === "string" ? <GuideSectionCopy id={id} label={title} /> : null}</div> : null}
            {description ? <p className="text-body text-text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div>{children}</div>
    </section>
  );
}
