import type { Metadata } from "next";
import type { ReactNode } from "react";
export const metadata: Metadata = { title: "Build Studio · Admin", robots: { index: false } };
export default function BuildStudioLayout({ children }: { children: ReactNode }) { return children; }
