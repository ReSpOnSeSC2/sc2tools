"use client";

import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LifeBuoy } from "lucide-react";
import type { ReportType } from "@/lib/feedback/reportContext";
import { helpMenuItems, type HelpMenuGroup, type HelpMenuItem } from "./helpMenu";

const ITEM_CLASS = [
  "flex min-h-11 w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-caption font-semibold text-text",
  "hover:bg-bg-elevated focus:bg-bg-elevated focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
].join(" ");

const GROUP_ORDER: readonly HelpMenuGroup[] = ["help", "feedback", "support"];

function menuItemsIn(menu: HTMLElement | null): HTMLElement[] {
  return Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
}

/**
 * The "?" Help & support button in the app's top bar, and its menu:
 * help articles, the Stream Studio course, the desktop app download,
 * Report a problem / Suggest a feature (signed in) or the support email
 * (signed out), and donations.
 *
 * Keyboard: Enter, Space or ↓ opens on the first item, ↑ on the last;
 * ↑/↓ move, Home/End jump, Esc closes and returns to the button, Tab
 * closes and moves on. A click outside or a navigation closes it too.
 * On phones the menu spans the screen under the top bar.
 */
export function HelpMenu({
  signedIn,
  onReport,
  className = "",
}: {
  signedIn: boolean;
  /** Opens the report form; without it the report items are left out. */
  onReport?: (type: ReportType) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonId = useId();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef<"first" | "last">("first");
  const pathname = usePathname();
  const items = helpMenuItems(signedIn && Boolean(onReport));

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const all = menuItemsIn(menuRef.current);
    (focusOnOpen.current === "last" ? all[all.length - 1] : all[0])?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function openMenu(at: "first" | "last") {
    focusOnOpen.current = at;
    setOpen(true);
  }

  function onButtonKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openMenu(event.key === "ArrowUp" ? "last" : "first");
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const all = menuItemsIn(menuRef.current);
    const index = all.indexOf(document.activeElement as HTMLElement);
    const focusAt = (next: number) => all[(next + all.length) % all.length]?.focus();
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusAt(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusAt(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusAt(0);
        break;
      case "End":
        event.preventDefault();
        focusAt(all.length - 1);
        break;
      case "Escape":
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  }

  function report(type: ReportType) {
    // Park focus on the button first: the menu item is about to unmount,
    // and the form hands focus back to whatever had it when it opened.
    buttonRef.current?.focus();
    setOpen(false);
    onReport?.(type);
  }

  const groups = GROUP_ORDER.map((group) => items.filter((item) => item.group === group)).filter(
    (group) => group.length > 0,
  );

  return (
    <div ref={rootRef} className={["relative", className].filter(Boolean).join(" ")}>
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Help & support"
        title="Help & support"
        onClick={() => (open ? setOpen(false) : openMenu("first"))}
        onKeyDown={onButtonKeyDown}
        className={[
          "hard-press inline-flex h-9 w-9 items-center justify-center rounded-full",
          "border-2 border-line bg-bg-surface text-text hover:bg-bg-elevated",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        ].join(" ")}
      >
        <LifeBuoy className="h-4 w-4" aria-hidden />
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-labelledby={buttonId}
          onKeyDown={onMenuKeyDown}
          className={[
            "fixed inset-x-4 top-14 z-50 rounded-xl border-2 border-line bg-bg-surface p-1.5 shadow-hard",
            "sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-72",
          ].join(" ")}
        >
          {groups.map((group, index) => (
            <Fragment key={group[0].group}>
              {index > 0 ? <div role="separator" className="mx-1 my-1 border-t border-border" /> : null}
              {group.map((item) => (
                <HelpMenuEntry
                  key={item.key}
                  item={item}
                  onNavigate={() => setOpen(false)}
                  onReport={report}
                />
              ))}
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function HelpMenuEntry({
  item,
  onNavigate,
  onReport,
}: {
  item: HelpMenuItem;
  onNavigate: () => void;
  onReport: (type: ReportType) => void;
}) {
  const Icon = item.icon;
  const content = (
    <>
      <Icon className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
      {item.label}
    </>
  );
  if (item.report) {
    const type = item.report;
    return (
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => onReport(type)} className={ITEM_CLASS}>
        {content}
      </button>
    );
  }
  if (item.href.startsWith("mailto:")) {
    return (
      <a href={item.href} role="menuitem" tabIndex={-1} onClick={onNavigate} className={ITEM_CLASS}>
        {content}
      </a>
    );
  }
  return (
    <Link href={item.href} role="menuitem" tabIndex={-1} onClick={onNavigate} className={ITEM_CLASS}>
      {content}
    </Link>
  );
}
