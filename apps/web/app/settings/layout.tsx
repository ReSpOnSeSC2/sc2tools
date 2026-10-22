import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * /settings layout — metadata only. The page is a client component, so
 * its title lives here; the open tab then names itself in the browser
 * tab ("Overlay · Settings · SC2 Tools", see SettingsShell).
 */
export const metadata: Metadata = {
  title: "Settings",
};

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return children;
}
