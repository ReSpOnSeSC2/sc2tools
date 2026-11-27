import type { Metadata } from "next";
import type { ReactNode } from "react";
export const metadata: Metadata = { title: "Humdingers · Admin", robots: { index: false } };
export default function HumdingersAdminLayout({ children }: { children: ReactNode }) { return children; }
