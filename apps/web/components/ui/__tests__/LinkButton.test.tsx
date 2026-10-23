import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Button, LinkButton, buttonClasses, type ButtonSize, type ButtonVariant } from "../Button";

afterEach(cleanup);
const variants: ButtonVariant[] = ["primary", "secondary", "ghost", "danger"];
const sizes: ButtonSize[] = ["sm", "md", "lg"];
it.each(variants.flatMap((variant) => sizes.map((size) => ({ variant, size }))))("shares classes and navigation semantics for $variant/$size", ({ variant, size }) => {
  render(<><Button variant={variant} size={size}>Save</Button><LinkButton href="/community?sort=new" variant={variant} size={size}>Browse</LinkButton></>);
  const button = screen.getByRole("button", { name: "Save" }); const link = screen.getByRole("link", { name: "Browse" });
  expect(link.className).toBe(button.className); expect(link.className).toBe(buttonClasses({ variant, size }));
  expect(link.getAttribute("href")).toBe("/community?sort=new");
});
