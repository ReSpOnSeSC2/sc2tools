"use client";

import { useId, useRef, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { PageHeader } from "@/components/ui/PageHeader";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import { slugForTab, TABS, type TabId } from "./tabs";

/**
 * SectionHeader — the top of an analyzer section (/app/<section> and
 * /app/opponents): the section's name, its one-line intro from tabs.ts,
 * a "How to read this" link and an optional actions slot.
 *
 * The title is an h2: the app's context bar is the page's h1 on every
 * analyzer section.
 *
 * "How to read this" opens the section's help article in a side sheet.
 * Its slug is the section's URL segment (/app/maps → /help/maps), so
 * every section has exactly one article (the help tests check it).
 *
 * "Hide intro" hides the one-line intro for that section on this
 * device (localStorage `analyzer.intro.hidden.<tabId>`); following
 * "How to read this" brings it back.
 *
 * Example:
 *   <SectionHeader tab="battlefield" actions={<Badge>12 maps</Badge>} />
 */

/** localStorage key for a section's "Hide intro" choice. */
export function introHiddenKey(tab: TabId): string {
  return `analyzer.intro.hidden.${tab}`;
}

function isBoolean(raw: unknown): raw is boolean {
  return typeof raw === "boolean";
}

export interface SectionHeaderProps {
  tab: TabId;
  /** Replaces the tabs.ts label. */
  title?: ReactNode;
  /** Replaces the tabs.ts description. */
  description?: ReactNode;
  /** Section-level controls, shown before "How to read this". */
  actions?: ReactNode;
  className?: string;
}

const CONTROL_CLASS =
  "inline-flex min-h-11 items-center gap-1.5 text-caption";

export function SectionHeader({ tab, title, description, actions, className = "" }: SectionHeaderProps) {
  const def = TABS.find((item) => item.id === tab);
  const intro = description ?? def?.description;
  const [hidden, setHidden] = useLocalStorageState<boolean>(introHiddenKey(tab), false, isBoolean);
  const helpRef = useRef<HTMLSpanElement>(null);
  const introId = useId();
  const showIntro = Boolean(intro) && !hidden;

  const hideIntro = () => {
    setHidden(true);
    // The button goes away with the intro: hand focus to the link that
    // brings it back instead of dropping it on the page.
    helpRef.current?.querySelector<HTMLElement>("a")?.focus();
  };

  return (
    <PageHeader
      as="h2"
      size="section"
      title={title ?? def?.label ?? tab}
      description={showIntro ? intro : undefined}
      descriptionId={introId}
      className={className}
      actions={
        <>
          {actions}
          <span ref={helpRef} className="inline-flex">
            <LazyHelpLink slug={slugForTab(tab)} className={CONTROL_CLASS} onOpen={() => setHidden(false)}>
              <CircleHelp className="h-4 w-4 shrink-0" aria-hidden />
              How to read this
            </LazyHelpLink>
          </span>
          {showIntro ? (
            <button
              type="button"
              onClick={hideIntro}
              aria-controls={introId}
              className={[
                CONTROL_CLASS,
                "rounded-sm px-1 text-text-dim hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              ].join(" ")}
            >
              Hide intro
            </button>
          ) : null}
        </>
      }
    />
  );
}
