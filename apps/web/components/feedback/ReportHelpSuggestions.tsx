"use client";

import { useDeferredValue, useId, useMemo } from "react";
import { BookOpen } from "lucide-react";
import { HelpLink } from "@/components/help/HelpLink";
import { reportHelpSuggestions } from "@/lib/feedback/suggestions";

/**
 * "These might help": up to three help articles matching the subject as
 * it is typed. Each opens in the side sheet, so the draft stays put.
 * The count is announced politely; the list itself is not, so a screen
 * reader isn't read every title on each keystroke.
 */
export function ReportHelpSuggestions({ subject }: { subject: string }) {
  const headingId = useId();
  const deferred = useDeferredValue(subject);
  const articles = useMemo(() => reportHelpSuggestions(deferred), [deferred]);
  const count = articles.length;

  return (
    <>
      <p role="status" className="sr-only">
        {count === 0 ? "" : count === 1 ? "1 help article might help." : `${count} help articles might help.`}
      </p>
      {count > 0 ? (
        <section
          aria-labelledby={headingId}
          className="rounded-lg border border-accent-cyan/30 bg-accent-cyan/5 px-3 py-2.5"
        >
          <h3 id={headingId} className="flex items-center gap-1.5 text-caption font-semibold text-text">
            <BookOpen className="h-4 w-4 shrink-0 text-accent-cyan" aria-hidden />
            These might help
          </h3>
          <ul className="mt-1 space-y-0.5">
            {articles.map((article) => (
              <li key={article.slug} className="text-caption">
                <HelpLink slug={article.slug} className="inline-flex min-h-9 items-center">
                  {article.title}
                </HelpLink>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
