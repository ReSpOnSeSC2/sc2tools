"use client";
import { useEffect, useRef, useState } from "react";

/** A shared cursor is usable without inventing the pages which preceded it. */
export function useAdminCursor(before: string, setBefore: (before: string) => void) {
  const [stack, setStack] = useState<string[]>([]);
  const expected = useRef(before);
  useEffect(() => {
    if (before !== expected.current) setStack(previous => { const index = previous.lastIndexOf(before); return index < 0 ? [] : previous.slice(0, index); });
    if (!before) setStack([]);
    expected.current = before;
  }, [before]);
  return { hasPrev: !!before, prevLabel: before && !stack.length ? "First page" : "Previous", page: before ? stack.length ? `Page ${stack.length + 1}` : "Shared page" : "Page 1",
    next: (cursor: string) => { if (cursor) { expected.current = cursor; setStack(previous => [...previous, before]); setBefore(cursor); } },
    previous: () => { expected.current = stack.at(-1) || ""; setBefore(expected.current); setStack(previous => previous.slice(0, -1)); } };
}
