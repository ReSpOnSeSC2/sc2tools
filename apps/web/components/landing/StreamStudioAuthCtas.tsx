"use client";
import Link from "next/link";
import { SignedIn, SignedOut, useAuth } from "@clerk/nextjs";
import { StreamStudioSignedOutCtas } from "./StreamStudioSignedOutCtas";
import { buttonClassName } from "@/components/ui/Button";

/** Keep server and first client markup useful while Clerk resolves. */
export default function StreamStudioAuthCtas() {
  const { isLoaded } = useAuth();
  if (!isLoaded) return <StreamStudioSignedOutCtas />;
  return <><SignedIn>
    <Link href="/settings?tab=overlay" className={buttonClassName({ size: "lg" })}>Open Overlay settings</Link>
    <Link href="/settings?tab=chat#stream-dock" className={buttonClassName({ variant: "secondary", size: "lg" })}>Set up my Stream Dock</Link>
    <Link href="/stream-studio/learn#crash-course" className={buttonClassName({ variant: "ghost" })}>Continue the crash course</Link>
  </SignedIn><SignedOut><StreamStudioSignedOutCtas /></SignedOut></>;
}
