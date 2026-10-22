import type { Metadata } from "next";
import type { ReactNode } from "react";

/** /coaching layout — metadata only (the Locker page is a client component). */
export const metadata: Metadata = {
  title: "Coaching",
};

export default function CoachingLayout({ children }: { children: ReactNode }) {
  return children;
}
