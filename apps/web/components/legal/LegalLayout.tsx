import type { ReactNode } from "react";

export interface LegalSectionLink { id: string; title: string }
export function legalSectionId(title: string): string { return title.toLowerCase().replace(/^[0-9]+[. ]*/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
export function LegalHeading({ id, children }: { id: string; children: string }) {
  return <h2 id={id} className="group scroll-mt-24 text-h3 font-semibold text-text">{children}<a href={"#" + id} aria-label={"Link to section: " + children} className="ml-2 text-accent opacity-0 group-hover:opacity-100 focus-visible:opacity-100">#</a></h2>;
}
/** Shared server-rendered policy typography, navigation and print presentation. */
export function LegalLayout({ title, updated, summary, sections, children }: { title: string; updated: string; summary?: ReactNode; sections: readonly LegalSectionLink[]; children: ReactNode }) {
  const date = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(updated + "T00:00:00Z"));
  const links = <ol className="space-y-2">{sections.map((section) => <li key={section.id}><a href={"#" + section.id}>{section.title}</a></li>)}</ol>;
  return <article data-legal className="mx-auto max-w-6xl text-text [&_a]:rounded-sm [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:text-accent-hover [&_a:focus-visible]:outline-none [&_a:focus-visible]:ring-2 [&_a:focus-visible]:ring-accent">
    <header className="mb-8 space-y-2"><h1 className="font-display text-h1 font-bold">{title}</h1><p className="text-caption text-text-muted">Last updated <time dateTime={updated}>{date}</time></p></header>
    {summary}
    <div className="grid min-w-0 gap-8 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside data-legal-toc className="min-w-0 text-caption"><nav aria-label="On this page" className="hidden lg:sticky lg:top-24 lg:block"><h2 className="mb-3 font-semibold">On this page</h2>{links}</nav><details className="rounded-lg border border-border p-3 lg:hidden"><summary className="cursor-pointer font-semibold">On this page</summary><nav aria-label="On this page" className="mt-3">{links}</nav></details></aside>
      <div className="min-w-0 max-w-prose space-y-7 break-words text-body leading-relaxed [&_section]:space-y-3 [&_p]:my-3">{children}</div>
    </div>
    <style>{'@media print { header, footer, [data-legal-toc], [data-cookie-banner] { display:none!important } [data-legal] > header { display:block!important } html,body,[data-legal],[data-legal] * { color:#000!important;background:#fff!important;box-shadow:none!important } [data-legal] a[href^="http"]::after { content:" (" attr(href) ")";font-size:10pt } [data-legal] { max-width:none!important } }'}</style>
  </article>;
}
