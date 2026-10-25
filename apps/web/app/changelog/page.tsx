import type { Metadata } from "next";
import Link from "next/link";
import { Changelog } from "@/components/announcements/Changelog";
import { PageHeader } from "@/components/ui/PageHeader";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { pageMetadata } from "@/lib/seo/pageMetadata";

export const metadata: Metadata = { ...pageMetadata({ title: "What's new", description: "Recent improvements to SC2 Tools, the desktop app, Stream Studio and guides.", canonical: "/changelog" }), alternates: { canonical: "/changelog", types: { "application/rss+xml": "/changelog/rss.xml" } } };
export default function ChangelogPage() {
  return <main className="mx-auto max-w-3xl space-y-6 px-4 py-10"><PageHeader title="What's new" description="Recent improvements, with a short guide to using each one." actions={<><Link className="rounded px-3 py-2 text-caption text-accent-cyan focus-visible:ring-2 focus-visible:ring-accent" href="/changelog/rss.xml">RSS feed</Link><LazyHelpLink slug="stay-up-to-date" /></>} /><Changelog /></main>;
}
