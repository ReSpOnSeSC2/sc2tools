import type { ReactNode } from "react";

export const metadata = { title: "Ghost examples · Admin", robots: { index: false } };

export default function GhostExamplesLayout({ children }: { children: ReactNode }) { return <>{children}</>; }
