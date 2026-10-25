import { signInHref } from "@/lib/authLinks";
/** Guide prompts share the application's post-auth context validator. */
export function guideSignInHref(path: string | null): string {
  return path && /^\/guides(?:[/?]|$)/.test(path) ? signInHref(path) : "/sign-in";
}
