import Link from "next/link";
import { AlertTriangle, Info, X } from "lucide-react";

export type SiteNotice = { severity: "info" | "warning" | "critical"; audience: "all" | "website" | "agent" | "stream-studio" | "guides"; message: string; href: string | null; startsAt: string; endsAt: string; revision: number; hash: string };
export function Banner({ notice, onDismiss }: { notice: SiteNotice; onDismiss?: () => void }) {
  const Icon = notice.severity === "info" ? Info : AlertTriangle;
  const tone = notice.severity === "critical" ? "border-danger/50 bg-danger/10 text-danger" : notice.severity === "warning" ? "border-warning/50 bg-warning/10 text-warning" : "border-accent/40 bg-accent/10 text-accent-cyan";
  return <div role="status" className={`flex items-start gap-2 border-y px-4 py-3 text-caption ${tone}`}>
    <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /><p className="min-w-0 flex-1 break-words">{notice.message}{notice.href ? <> <Link href={notice.href} className="rounded font-semibold underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current">More information</Link></> : null}</p>
    {notice.severity !== "critical" && onDismiss ? <button type="button" aria-label="Dismiss notice" onClick={onDismiss} className="-my-1 rounded p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"><X className="h-4 w-4" aria-hidden /></button> : null}
  </div>;
}
