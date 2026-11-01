import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Wordmark } from "../Wordmark";

afterEach(cleanup);

describe("Wordmark", () => {
  it.each([["md", "text-h4", "h-1.5"], ["sm", "text-caption", "h-1"]] as const)(
    "renders the display-face name with its accent tick at %s", (size, text, tick) => {
      const { container } = render(<Wordmark size={size} className="group-hover:text-accent" />);
      const mark = container.firstElementChild as HTMLElement;
      expect(mark.textContent).toBe("SC2 Tools");
      expect(mark.className.split(" ")).toEqual(expect.arrayContaining(["font-display", "font-extrabold", text, "group-hover:text-accent"]));
      const dot = mark.querySelector<HTMLElement>("span[aria-hidden]");
      expect(dot?.className.split(" ")).toEqual(expect.arrayContaining(["rounded-full", "bg-accent", tick]));
    });
});
