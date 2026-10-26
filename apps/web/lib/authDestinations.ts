import { safeReturnPath } from "./safeReturnPath";
import { TRY_RESUME_PATH } from "./instant/authRedirect";

/** Force both Clerk form destinations, including the built-in switch-form
 * links, so its raw redirect_url cannot bypass our application allowlist. */
export function authDestinations(value: unknown) {
  const returnTo = safeReturnPath(value);
  return { returnTo, signIn: returnTo ?? "/app", signUp: returnTo === TRY_RESUME_PATH ? returnTo : returnTo ? `/welcome?next=${encodeURIComponent(returnTo)}` : "/welcome" };
}
