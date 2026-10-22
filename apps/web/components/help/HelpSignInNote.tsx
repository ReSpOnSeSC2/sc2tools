"use client";

import Link from "next/link";
import { SignedOut } from "@clerk/nextjs";
import { LogIn } from "lucide-react";
import { HELP_TEXT_LINK_CLASS } from "./HelpInline";

/**
 * Shown on public articles marked `signedInOnly`: the article still
 * reads fine for everyone, but its steps happen in your account. Only
 * signed-out visitors see it.
 */
export function HelpSignInNote() {
  return (
    <SignedOut>
      <div role="note" className="flex gap-3 rounded-lg border border-accent-cyan/40 bg-accent-cyan/10 px-4 py-3 text-body text-text-muted">
        <LogIn className="mt-1 h-4 w-4 shrink-0 text-accent-cyan" aria-hidden />
        <p>
          The steps in this article happen in your account.{" "}
          <Link href="/sign-in" className={HELP_TEXT_LINK_CLASS}>
            Sign in
          </Link>{" "}
          or{" "}
          <Link href="/sign-up" className={HELP_TEXT_LINK_CLASS}>
            create an account
          </Link>{" "}
          to follow along.
        </p>
      </div>
    </SignedOut>
  );
}
