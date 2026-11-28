import type { Metadata } from "next";
import type { ReactNode } from "react";
export const metadata: Metadata = { title: "Humdingers replay · Admin", robots: { index: false } };
export default function HumdingersWatchLayout({ children }: { children: ReactNode }) { return children; }
