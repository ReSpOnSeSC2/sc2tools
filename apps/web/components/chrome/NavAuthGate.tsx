"use client";

import type { ReactNode } from "react";
import { SignedIn, SignedOut } from "@clerk/nextjs";
import type { MobileNavLink } from "./MobileNav";

/**
 * Render a header or drawer link only for the viewers its `auth` names.
 * Clerk's gates render nothing until it has loaded, so a link never
 * flashes for the wrong audience.
 *
 * Example: `<NavAuthGate auth="out"><NavLink href="/try" … /></NavAuthGate>`
 * shows the link to signed-out visitors only.
 */
export function NavAuthGate({ auth, children }: { auth: MobileNavLink["auth"]; children: ReactNode }) {
  if (auth === "in" || auth === "admin") return <SignedIn>{children}</SignedIn>;
  if (auth === "out") return <SignedOut>{children}</SignedOut>;
  return <>{children}</>;
}
