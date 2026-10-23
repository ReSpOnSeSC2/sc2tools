import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DefinitionsBackLink } from "./DefinitionsBackLink";
const auth = vi.hoisted(() => ({ signedIn: false }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isSignedIn: auth.signedIn }) }));
afterEach(cleanup);
it.each([false, true])("offers the useful destination for signed-in=%s readers", (signedIn) => {
  auth.signedIn = signedIn; render(<DefinitionsBackLink />);
  expect(screen.getByRole("link", { name: signedIn ? "Your build library" : "Community builds" }).getAttribute("href")).toBe(signedIn ? "/builds" : "/community");
});
