import type { Metadata } from "next";
import type { ReactNode } from "react";

/** /sign-in layout — metadata only (Clerk's widget page is a client component). */
export const metadata: Metadata = {
  title: "Sign in",
};

export default function SignInLayout({ children }: { children: ReactNode }) {
  return children;
}
