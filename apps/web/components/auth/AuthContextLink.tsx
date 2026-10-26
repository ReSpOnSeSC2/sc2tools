"use client";
import { Suspense, type ComponentProps } from "react";
import Link from "next/link";
import { signInHref, signUpHref } from "@/lib/authLinks";
import { useReturnTo } from "@/lib/authReturnHooks";

type Props = Omit<ComponentProps<typeof Link>, "href"> & { kind: "sign-in" | "sign-up"; returnTo?: string | null };
/** Only the auth link reads search parameters; the surrounding public page
 * and navigation remain statically rendered with a usable fallback href. */
export function AuthContextLink(props: Props) {
  const { kind, returnTo, ...link } = props;
  const href = kind === "sign-in" ? signInHref(returnTo) : signUpHref(returnTo);
  return <Suspense fallback={<Link {...link} href={href} />}><ContextLink {...props} /></Suspense>;
}
function ContextLink({ kind, returnTo, ...link }: Props) {
  const path = useReturnTo(returnTo);
  return <Link {...link} href={kind === "sign-in" ? signInHref(path) : signUpHref(path)} />;
}
