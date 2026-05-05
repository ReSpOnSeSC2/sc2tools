"use client";

import {
  createContext,
  useContext,
  useId,
  useRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/**
 * Tabs — accessible tabs/tabpanel composite.
 *
 * Usage:
 *   <Tabs value={tab} onValueChange={setTab} orientation="horizontal">
 *     <Tabs.List ariaLabel="Sections">
 *       <Tabs.Trigger value="a">A</Tabs.Trigger>
 *       <Tabs.Trigger value="b">B</Tabs.Trigger>
 *     </Tabs.List>
 *     <Tabs.Content value="a">…</Tabs.Content>
 *     <Tabs.Content value="b">…</Tabs.Content>
 *   </Tabs>
 *
 * Horizontal orientation uses left/right arrows; vertical uses
 * up/down. Home/End jump to first/last. Roving tabindex pattern.
 */

export type TabsOrientation = "horizontal" | "vertical";

interface TabsContextValue {
  value: string;
  setValue: (next: string) => void;
  baseId: string;
  orientation: TabsOrientation;
  registerTrigger: (el: HTMLButtonElement | null, value: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("Tabs.* must be used inside <Tabs>.");
  return ctx;
}

export interface TabsProps {
  value: string;
  onValueChange: (next: string) => void;
  orientation?: TabsOrientation;
  className?: string;
  children: ReactNode;
}

export function Tabs({
  value,
  onValueChange,
  orientation = "horizontal",
  className = "",
  children,
}: TabsProps) {
  const baseId = useId();
  const triggersRef = useRef<Map<string, HTMLButtonElement>>(new Map());

  const registerTrigger = (el: HTMLButtonElement | null, v: string) => {
    if (el) triggersRef.current.set(v, el);
    else triggersRef.current.delete(v);
  };

  const ctx: TabsContextValue = {
    value,
    setValue: onValueChange,
    baseId,
    orientation,
    registerTrigger,
  };

  return (
    <TabsContext.Provider value={ctx}>
      <div
        className={[
          orientation === "vertical"
            ? "grid grid-cols-1 gap-6 lg:grid-cols-[220px_1fr]"
            : "space-y-4",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {children}
      </div>
    </TabsContext.Provider>
  );
}

interface TabsListProps extends HTMLAttributes<HTMLDivElement> {
  ariaLabel: string;
  children: ReactNode;
}

Tabs.List = function TabsList({
  ariaLabel,
  className = "",
  children,
  ...rest
}: TabsListProps) {
  const { orientation } = useTabs();
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation={orientation}
      className={[
        orientation === "horizontal"
          ? "flex flex-wrap items-center gap-1 border-b border-border overflow-x-auto"
          : "card sticky top-4 flex h-fit flex-col gap-0.5 overflow-hidden p-1",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </div>
  );
};

export interface TabsTriggerProps
  extends HTMLAttributes<HTMLButtonElement> {
  value: string;
  disabled?: boolean;
  children: ReactNode;
}

Tabs.Trigger = function TabsTrigger({
  value: triggerValue,
  disabled,
  className = "",
  children,
  ...rest
}: TabsTriggerProps) {
  const { value, setValue, baseId, orientation, registerTrigger } = useTabs();
  const selected = value === triggerValue;
  const triggerId = `${baseId}-trigger-${triggerValue}`;
  const panelId = `${baseId}-panel-${triggerValue}`;

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const list = (e.currentTarget.parentElement ?? null) as HTMLElement | null;
    if (!list) return;
    const items = Array.from(
      list.querySelectorAll<HTMLButtonElement>("[role=tab]:not(:disabled)"),
    );
    const idx = items.indexOf(e.currentTarget);
    if (idx < 0) return;
    let next: number | null = null;
    const horizontal = orientation === "horizontal";
    if ((horizontal && e.key === "ArrowRight") || (!horizontal && e.key === "ArrowDown")) {
      next = (idx + 1) % items.length;
    } else if ((horizontal && e.key === "ArrowLeft") || (!horizontal && e.key === "ArrowUp")) {
      next = (idx - 1 + items.length) % items.length;
    } else if (e.key === "Home") {
      next = 0;
    } else if (e.key === "End") {
      next = items.length - 1;
    }
    if (next !== null) {
      e.preventDefault();
      const target = items[next];
      target.focus();
      const v = target.getAttribute("data-value");
      if (v) setValue(v);
    }
  };

  return (
    <button
      ref={(el) => registerTrigger(el, triggerValue)}
      type="button"
      role="tab"
      id={triggerId}
      data-value={triggerValue}
      aria-selected={selected}
      aria-controls={panelId}
      tabIndex={selected ? 0 : -1}
      disabled={disabled}
      onClick={() => setValue(triggerValue)}
      onKeyDown={handleKeyDown}
      className={[
        "min-h-[44px]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "transition-colors",
        orientation === "horizontal"
          ? [
              "-mb-px border-b-2 px-3 py-2 text-caption whitespace-nowrap",
              selected
                ? "border-accent text-accent"
                : "border-transparent text-text-muted hover:text-text",
            ].join(" ")
          : [
              "block w-full rounded-md px-3 py-2 text-left text-caption",
              selected
                ? "bg-accent/15 text-accent"
                : "text-text-muted hover:bg-bg-elevated hover:text-text",
            ].join(" "),
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
};

export interface TabsContentProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
  children: ReactNode;
}

Tabs.Content = function TabsContent({
  value: contentValue,
  className = "",
  children,
  ...rest
}: TabsContentProps) {
  const { value, baseId } = useTabs();
  const selected = value === contentValue;
  const triggerId = `${baseId}-trigger-${contentValue}`;
  const panelId = `${baseId}-panel-${contentValue}`;
  return (
    <div
      role="tabpanel"
      id={panelId}
      aria-labelledby={triggerId}
      hidden={!selected}
      tabIndex={0}
      className={[
        "focus-visible:outline-none",
        selected ? "" : "hidden",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {selected ? children : null}
    </div>
  );
};
