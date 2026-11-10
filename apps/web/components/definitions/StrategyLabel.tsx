import Link from "next/link";
import { definitionHref } from "@/lib/definition-links";

export function StrategyLabel({ label, onClick }: { label: string; onClick?: () => void }) {
  const href = definitionHref(label);
  return href ? <Link href={href} onClick={onClick} aria-label={`What is ${label}?`} className="text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{label}</Link> : <>{label}</>;
}
