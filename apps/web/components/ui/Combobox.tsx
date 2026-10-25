"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { Input } from "./Input";

export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
  searchTerms?: readonly string[];
  icon?: ReactNode;
  disabled?: boolean;
}
export interface ComboboxProps {
  label: string;
  value: string;
  options: readonly ComboboxOption[];
  onChange: (value: string) => void;
  /** Optional draft text. Selection-only callers can omit this. */
  onInputChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  autoFocus?: boolean;
  emptyMessage?: string;
  className?: string;
}
const RESULT_LIMIT = 60;
const key = (value: string) => value.toLocaleLowerCase().trim();

/** ARIA 1.2 editable combobox. Focus stays in the input while the bounded
 * list uses active-descendant; Tab always follows the surrounding form. */
export function Combobox({ label, value, options, onChange, onInputChange, placeholder = "Search…", disabled = false,
  invalid = false, describedBy, autoFocus = false, emptyMessage = "No matching options", className = "" }: ComboboxProps) {
  const id = useId(), listId = `${id}-options`, root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState<{ value: string; text: string } | null>(null), [active, setActive] = useState(-1);
  const [position, setPosition] = useState<CSSProperties | null>(null), [portalHost, setPortalHost] = useState<Element | null>(null);
  // A controlled reset must replace a pending search in the same render.
  // Draft-text callers echo the typed value; selection-only callers keep it.
  const currentQuery = query?.value === value ? query.text : null;
  const selected = options.find(option => option.value === value), needle = key(currentQuery ?? "");
  const matches = useMemo(() => options.filter(option => !needle || [option.label, option.value, ...(option.searchTerms ?? [])].some(text => key(text).includes(needle))), [needle, options]);
  const visible = matches.slice(0, RESULT_LIMIT), shown = open && !disabled;
  const activeOption = visible[active];
  const close = () => { setOpen(false); setActive(-1); setQuery(null); };
  const choose = (option: ComboboxOption) => { if (!option.disabled) { onChange(option.value); close(); input.current?.focus(); } };
  const enabled = visible.flatMap((option, index) => option.disabled ? [] : [index]);
  const move = (direction: 1 | -1) => {
    setOpen(true);
    const current = enabled.indexOf(active), next = current < 0 ? (direction === 1 ? 0 : enabled.length - 1) : (current + direction + enabled.length) % enabled.length;
    setActive(enabled[next] ?? -1);
  };
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); }
    else if (shown && (event.key === "Home" || event.key === "End")) { event.preventDefault(); setActive((event.key === "Home" ? enabled[0] : enabled.at(-1)) ?? -1); }
    else if (shown && event.key === "Enter") { event.preventDefault(); if (activeOption) choose(activeOption); }
    else if (shown && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === "Tab") close();
  }
  useEffect(() => { if (autoFocus) input.current?.focus(); }, [autoFocus]);
  useLayoutEffect(() => {
    if (!shown) return;
    const place = () => {
      const box = input.current?.getBoundingClientRect(); if (!box) return;
      const above = window.innerHeight - box.bottom < 260 && box.top > window.innerHeight - box.bottom;
      setPosition({ left: Math.max(4, Math.min(box.left, window.innerWidth - box.width - 4)), width: Math.min(box.width, window.innerWidth - 8),
        ...(above ? { bottom: window.innerHeight - box.top + 4 } : { top: box.bottom + 4 }), maxHeight: Math.max(44, Math.min(304, (above ? box.top : window.innerHeight - box.bottom) - 8)) });
      // A portal inside the active dialog escapes its nested rules scroller
      // while remaining inside the dialog's focus/inert boundary.
      setPortalHost(root.current?.closest('[role="dialog"]') ?? document.body);
    };
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) { setOpen(false); setActive(-1); setQuery(null); } };
    place(); document.addEventListener("pointerdown", outside); window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [shown]);
  useEffect(() => { if (shown && active >= 0) document.getElementById(`${id}-option-${active}`)?.scrollIntoView?.({ block: "nearest" }); }, [active, id, shown]);
  return <div ref={root} className={`relative min-w-0 ${className}`} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !popup.current?.contains(event.relatedTarget as Node | null)) close(); }}>
    <div className="relative">
      <Input ref={input} role="combobox" aria-label={label} aria-autocomplete="list" aria-expanded={shown} aria-controls={shown ? listId : undefined}
        aria-activedescendant={shown && activeOption ? `${id}-option-${active}` : undefined} aria-describedby={describedBy}
        value={currentQuery ?? selected?.label ?? value} placeholder={placeholder} disabled={disabled} invalid={invalid} autoComplete="off" maxLength={80}
        className="min-h-11 pr-9" onFocus={() => { setOpen(true); setActive(-1); }} onKeyDown={onKeyDown}
        onChange={event => { setQuery({ value: onInputChange ? event.target.value : value, text: event.target.value }); setActive(-1); setOpen(true); onInputChange?.(event.target.value); }} />
      <ChevronDown aria-hidden className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
    </div>
    {shown && position && portalHost ? createPortal(<div ref={popup} style={position} className="fixed z-sheet flex flex-col overflow-hidden rounded-lg border-2 border-line bg-bg-surface shadow-xl">
      <ul id={listId} role="listbox" aria-label={`${label} options`} className="min-h-0 max-h-64 overflow-y-auto overscroll-contain p-1">
        {visible.map((option, index) => <li key={option.value} id={`${id}-option-${index}`} role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
          className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-body text-text ${index === active ? "bg-bg-elevated outline outline-2 -outline-offset-2 outline-accent" : "hover:bg-bg-elevated"} ${option.disabled ? "cursor-not-allowed opacity-50" : ""}`}
          onPointerMove={() => { if (!option.disabled) setActive(index); }} onMouseDown={event => event.preventDefault()} onClick={() => choose(option)}>
          {option.icon ? <span aria-hidden className="shrink-0">{option.icon}</span> : null}
          <span className="min-w-0 flex-1"><span className="block break-words">{option.label}</span>{option.description ? <span className="block break-words text-caption text-text-muted">{option.description}</span> : null}</span>
          {option.value === value ? <Check aria-hidden className="h-4 w-4 shrink-0" /> : null}
        </li>)}
      </ul>
      {visible.length === 0 ? <p role="status" className="p-3 text-caption text-text-muted">{emptyMessage}</p> : null}
      {matches.length > RESULT_LIMIT ? <p role="status" className="border-t border-border px-3 py-2 text-caption text-text-muted">Showing first {RESULT_LIMIT} matches. Type more to narrow the list.</p> : null}
    </div>, portalHost) : null}
  </div>;
}
