import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { HelpSearch } from "@/components/help/HelpSearch";
import { HelpSupportLine } from "@/components/help/HelpSupportLine";
import { articlesByCategory, helpArticlePath, popularArticles } from "@/lib/help";
import { helpInlinePlainText } from "@/lib/help/inline";

const TITLE = "Help center · SC2 Tools";
const DESCRIPTION =
  "How to set up SC2 Tools, pair the desktop app, read your stats, use build check-in and run Stream Studio. Search or browse by topic.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/help" },
  openGraph: { type: "website", siteName: "SC2 Tools", url: "/help", title: TITLE, description: DESCRIPTION },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
};

const TOPIC_LINK_CLASS =
  "group -mx-2 flex min-h-11 items-center justify-between gap-3 rounded-md px-2 py-1.5 text-body font-medium text-text hover:bg-bg-elevated hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/**
 * /help — the public help center: instant search, the Popular list, a
 * card per topic, and the support line. Public by design (keep it out
 * of middleware's isProtected list); the same articles appear in
 * Settings → Help.
 */
export default function HelpHubPage() {
  const groups = articlesByCategory();
  const popular = popularArticles();

  return (
    <div className="space-y-10">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <div className="min-w-0 space-y-6">
          <PageHeader
            eyebrow="Help center"
            title="How can we help?"
            description="Setup, your stats, build check-in and Stream Studio, step by step. Every number in SC2 Tools is computed from your replays with fixed rules."
          />
          <HelpSearch className="max-w-2xl" />
        </div>

        <aside aria-labelledby="help-popular-title">
          <Card>
            <h2 id="help-popular-title" className="overline text-text-dim">
              Popular
            </h2>
            <ol className="mt-2 space-y-1">
              {popular.map((article) => (
                <li key={article.slug}>
                  <Link href={helpArticlePath(article.slug)} className={TOPIC_LINK_CLASS}>
                    <span className="min-w-0">{article.title}</span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-text-dim group-hover:text-accent" aria-hidden />
                  </Link>
                </li>
              ))}
            </ol>
          </Card>
        </aside>
      </div>

      <section aria-labelledby="help-topics-title" className="space-y-4">
        <h2 id="help-topics-title" className="font-display text-h3 font-bold text-text">
          Browse by topic
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map(({ category, articles }) => (
            <Card key={category.id} id={category.id} aria-labelledby={`help-topic-${category.id}`} className="scroll-mt-24">
              <h3 id={`help-topic-${category.id}`} className="font-display text-h4 font-bold text-text">
                {category.name}
              </h3>
              <p className="mt-1 text-caption text-text-muted">{category.description}</p>
              <ul className="mt-3 space-y-1 border-t border-border pt-3">
                {articles.map((article) => (
                  <li key={article.slug}>
                    <Link
                      href={helpArticlePath(article.slug)}
                      className={TOPIC_LINK_CLASS}
                      title={helpInlinePlainText(article.summary)}
                    >
                      <span className="min-w-0">{article.title}</span>
                      <ArrowRight className="h-4 w-4 shrink-0 text-text-dim group-hover:text-accent" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      </section>

      <HelpSupportLine className="border-t border-border pt-6" />
    </div>
  );
}
