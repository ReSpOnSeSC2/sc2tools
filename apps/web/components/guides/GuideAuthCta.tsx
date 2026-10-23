"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { GUIDE_PRIMARY_ACTION_CLASS } from "./guideUi";

export function GuideAuthCta() {
  const { isLoaded, isSignedIn } = useAuth();
  const signedIn = isLoaded && isSignedIn;
  return <Link href={signedIn ? "/download" : "/sign-up"} className={GUIDE_PRIMARY_ACTION_CLASS}>
    {signedIn ? "Upload more games" : "Sign up free and track your games"}
  </Link>;
}
