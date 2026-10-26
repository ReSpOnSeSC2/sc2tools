import type { Metadata } from "next";
import type { ReactNode } from "react";

/** /sign-up layout — metadata only (Clerk's widget page is a client component). */
export const metadata: Metadata = {
  title: "Create your account",
  robots: { index: false, follow: false },
};

export default function SignUpLayout({ children }: { children: ReactNode }) {
  return children;
}
