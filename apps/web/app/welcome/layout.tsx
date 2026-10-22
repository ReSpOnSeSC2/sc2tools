import type { Metadata } from "next";
import type { ReactNode } from "react";

/** /welcome layout — metadata only (the setup wizard is a client component). */
export const metadata: Metadata = {
  title: "Welcome",
};

export default function WelcomeLayout({ children }: { children: ReactNode }) {
  return children;
}
