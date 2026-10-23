"use client";

import { useEffect, useId, useRef, useState } from "react";

/** A disclosure is offered only when the collapsed text actually overflows. */
export function ExpandableText({ text }: { text: string }) {
  const id = useId();
  const paragraph = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(text.length > 400 || text.split("\n").length > 6);
  useEffect(() => {
    if (expanded) return;
    const measure = () => {
      const node = paragraph.current;
      if (node && node.clientHeight > 0) setOverflows(node.scrollHeight > node.clientHeight + 1);
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (paragraph.current) observer?.observe(paragraph.current);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [expanded, text]);
  return <div>
    <p ref={paragraph} id={id} className={`whitespace-pre-line break-words text-body text-text-muted ${expanded ? "" : "line-clamp-6"}`}>{text}</p>
    {overflows ? <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((value) => !value)} className="mt-2 min-h-11 rounded-md font-semibold text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Show {expanded ? "less" : "more"}</button> : null}
  </div>;
}
