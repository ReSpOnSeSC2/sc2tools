import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { pageMetadata } from "@/lib/seo/pageMetadata";
import { StatusChecks } from "./StatusChecks";

export const metadata = pageMetadata({ title: "System status", description: "Check current website and API reachability from your browser.", canonical: "/status" });

export default function StatusPage() {
  return <main id="main-content" tabIndex={-1} className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:py-14">
    <PageHeader eyebrow="SC2 Tools" title="System status" description="Check whether the website and API are reachable from your browser right now." />
    <StatusChecks />
    <noscript><p className="rounded-xl border-2 border-line bg-bg-surface p-4 text-text">Enable JavaScript to run these browser reachability checks. You can still open SC2 Tools or Help below.</p></noscript>
    <nav aria-label="Status page links" className="flex flex-wrap gap-3">
      <Link href="/" prefetch={false} className={buttonClassName({ variant: "secondary" })}>Open SC2 Tools</Link>
      <Link href="/help" prefetch={false} className={buttonClassName({ variant: "ghost" })}>Help</Link>
    </nav>
  </main>;
}
