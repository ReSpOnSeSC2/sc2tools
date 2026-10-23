"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { ArrowLeft } from "lucide-react";

export function DefinitionsBackLink() {
  const { isSignedIn } = useAuth();
  return <Link href={isSignedIn ? "/builds" : "/community"} className="inline-flex min-h-11 items-center gap-1.5 text-caption font-medium text-text-muted hover:text-text"><ArrowLeft className="h-4 w-4" aria-hidden />{isSignedIn ? "Your build library" : "Community builds"}</Link>;
}
