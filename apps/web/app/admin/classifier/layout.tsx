import type { Metadata } from "next";
import type { ReactNode } from "react";
export const metadata: Metadata = { title: "Classifier · Admin", robots: { index: false } };
export default function ClassifierLayout({ children }: { children: ReactNode }) { return children; }
