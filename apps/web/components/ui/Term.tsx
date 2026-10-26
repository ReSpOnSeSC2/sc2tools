import type { ReactNode } from "react";
import { InfoTip } from "./InfoTip";

/** The visible word stays readable; its adjacent named button owns the tip. */
export function Term({ id, children, label }: { id: string; children: ReactNode; label?: string }) {
  return <span className="inline-flex max-w-full items-center gap-1" data-glossary-term={id}>
    <span className="underline decoration-dotted underline-offset-4">{children}</span>
    <InfoTip termId={id} label={label ?? (typeof children === "string" ? children : id)} />
  </span>;
}
