import Link from "next/link";
import { BackupRetention } from "@/components/legal/BackupRetention";
import { ISSUES_URL } from "@/lib/siteLinks";

export const metadata = { title: "Account deleted", robots: { index: false, follow: false } };

export default function GoodbyePage() {
  return <main className="mx-auto max-w-2xl space-y-5 px-5 py-16">
    <h1 className="text-h1 font-semibold">Your account has been deleted</h1>
    <p>Your live account data and private snapshots were removed. Your paired PCs and overlay links no longer have access.</p>
    <p>Comments on other people&apos;s review requests remain as [deleted user]. If sign-in identity deletion is temporarily unavailable, it is retried automatically; the deleted identity cannot reopen the account while the retry is pending.</p>
    <BackupRetention />
    <p className="text-body-sm text-text-muted">A minimal retry record is kept until identity deletion completes. After completion, only a keyed deletion guard remains for 30 days to reject old sessions and late identity events.</p>
    <p><a className="underline" href={ISSUES_URL}>Contact support</a> · <Link className="underline" href="/legal/privacy">Privacy policy</Link> · <Link className="underline" href="/">Home</Link></p>
  </main>;
}
