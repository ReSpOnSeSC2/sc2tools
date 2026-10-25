import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { isAppSurfacePath, isProtectedSurfacePath } from "@/components/chrome/appNav";
import { ALL_HELP_ARTICLES } from "@/lib/help";
import { HELP_CATEGORIES } from "@/lib/help/categories";

const auth = vi.hoisted(() => ({ signedIn: false }));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: auth.signedIn }),
  SignedOut: ({ children }: { children: ReactNode }) => (auth.signedIn ? null : <>{children}</>),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import HelpHubPage, { metadata as hubMetadata } from "../page";
import HelpArticlePage, { dynamicParams, generateMetadata, generateStaticParams } from "../[slug]/page";

afterEach(() => {
  cleanup();
  auth.signedIn = false;
});

async function renderArticle(slug: string) {
  render(await HelpArticlePage({ params: Promise.resolve({ slug }) }));
}

describe("/help", () => {
  it("is public: never behind sign-in and never inside the app chrome", () => {
    const middleware = readFileSync(path.resolve(__dirname, "../../../middleware.ts"), "utf8");
    const protectedList = middleware.slice(middleware.indexOf("createRouteMatcher(["), middleware.indexOf("]);"));
    expect(protectedList).not.toContain('"/help');
    expect(isProtectedSurfacePath("/help/getting-started")).toBe(false);
    expect(isAppSurfacePath("/help")).toBe(false);
  });

  it("has search, the Popular list, a card per topic and the support line", () => {
    expect(hubMetadata.alternates?.canonical).toBe("/help");
    render(<HelpHubPage />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "How can we help?" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search help" })).toBeTruthy();

    const popular = screen.getByRole("complementary", { name: "Popular" });
    expect(within(popular).getAllByRole("link")[0].getAttribute("href")).toBe("/help/getting-started");

    const builds = document.getElementById("builds") as HTMLElement;
    expect(within(builds).getByRole("heading", { level: 3, name: "Builds" })).toBeTruthy();
    expect(within(builds).getByRole("link", { name: /Build check-in/ }).getAttribute("href")).toBe("/help/build-check-in");
    // Topics with articles get a card; topics without articles yet stay hidden.
    expect(document.getElementById("account-data")).not.toBeNull();
    expect(document.getElementById("desktop-app")).not.toBeNull();
    for (const category of HELP_CATEGORIES) {
      const hasArticles = ALL_HELP_ARTICLES.some((article) => article.category === category.id);
      expect(document.getElementById(category.id) !== null, category.id).toBe(hasArticles);
    }

    expect(screen.getByRole("link", { name: "responsecoaching@gmail.com" }).getAttribute("href")).toBe(
      "mailto:responsecoaching@gmail.com",
    );
    expect(screen.queryByRole("button", { name: "Report a problem" })).toBeNull();
  });

  it("offers Report a problem to signed-in visitors", () => {
    auth.signedIn = true;
    render(<HelpHubPage />);
    expect(screen.getByRole("button", { name: "Report a problem" })).toBeTruthy();
  });
});

describe("/help/[slug]", () => {
  it("pre-renders every article and 404s anything else", async () => {
    expect(dynamicParams).toBe(false);
    expect(generateStaticParams()).toEqual(ALL_HELP_ARTICLES.map((article) => ({ slug: article.slug })));
    await expect(HelpArticlePage({ params: Promise.resolve({ slug: "nope" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("sets a canonical URL, title and description", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ slug: "getting-started" }) });
    expect(meta.alternates?.canonical).toBe("/help/getting-started");
    // The root template adds " · SC2 Tools"; the social card carries it itself.
    expect(meta.title).toBe("Getting started (5 minutes) · Help");
    expect(meta.openGraph?.title).toBe("Getting started (5 minutes) · Help · SC2 Tools");
    expect(meta.description).toContain("pair the desktop app");
    expect(meta.openGraph?.images).toEqual([expect.objectContaining({ url: "/og.jpg" })]);
    expect(meta.twitter).toEqual(expect.objectContaining({ card: "summary_large_image" }));
  });

  it("renders breadcrumbs, the article, its update date, related articles and structured data", async () => {
    await renderArticle("getting-started");
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Help center" }).getAttribute("href")).toBe("/help");
    expect(within(crumbs).getByRole("link", { name: "Getting started" }).getAttribute("href")).toBe("/help#getting-started");
    expect(screen.getByRole("heading", { level: 1, name: "Getting started (5 minutes)" })).toBeTruthy();
    expect(screen.getByText("October 25, 2026").closest("time")?.getAttribute("dateTime")).toBe("2026-10-25");
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe("/download");
    expect(screen.getByRole("link", { name: "Devices" }).getAttribute("href")).toBe("/devices");

    const related = screen.getByRole("heading", { level: 2, name: "Related articles" }).parentElement as HTMLElement;
    expect(within(related).getByRole("link", { name: /How to use Help/ }).getAttribute("href")).toBe("/help/how-to-use-help");

    const topic = screen.getByRole("navigation", { name: "In Getting started" });
    expect(within(topic).getByRole("link", { name: "Getting started (5 minutes)" }).getAttribute("aria-current")).toBe("page");

    const jsonLd = JSON.parse(screen.getByTestId("help-jsonld").textContent ?? "[]") as Array<{ "@type": string }>;
    expect(jsonLd.map((item) => item["@type"])).toEqual(["BreadcrumbList", "HowTo"]);
    // Articles for everyone show no sign-in note or audience label.
    expect(screen.queryByText(/The steps in this article happen in your account/)).toBeNull();
  });

  it("still renders signed-in-only articles, with a sign-in note for signed-out readers", async () => {
    await renderArticle("build-check-in");
    expect(screen.getByRole("heading", { level: 1, name: "Build check-in: count the build you went for" })).toBeTruthy();
    expect(screen.getByText("For players")).toBeTruthy();
    const note = screen.getByText(/The steps in this article happen in your account/).closest("[role='note']") as HTMLElement;
    expect(within(note).getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/sign-in");
    expect(screen.getByRole("link", { name: "Settings → Build check-in" }).getAttribute("href")).toBe("/settings?tab=checkin");
  });

  it("gives sections stable anchors: /help/replay-reviews#who-can-review lands on its heading", async () => {
    await renderArticle("replay-reviews");
    const heading = screen.getByRole("heading", { level: 2, name: "Who can review" });
    expect(heading.id).toBe("who-can-review");
    const desktopLinks = screen.getAllByRole("link", { name: "desktop app" });
    expect(desktopLinks.length).toBeGreaterThan(0);
    desktopLinks.forEach((link) => expect(link.getAttribute("href")).toBe("/download"));
    expect(screen.getByRole("heading", { name: /Find requests you can answer/ }).id).toBe("finding-requests");
    expect(screen.getByRole("heading", { name: /Your reviewer profile/ }).id).toBe("your-reviewer-profile");
    expect(screen.getByRole("heading", { name: /Track your requests and written reviews/ }).id).toBe("my-reviews");
  });

  it("keeps the invite-only coaching article out of search engines", async () => {
    const coaching = await generateMetadata({ params: Promise.resolve({ slug: "coaching" }) });
    expect(coaching.robots).toEqual({ index: false, follow: true });
    const reviews = await generateMetadata({ params: Promise.resolve({ slug: "replay-reviews" }) });
    expect(reviews.robots).toBeUndefined();

    await renderArticle("coaching");
    expect(screen.getByRole("heading", { level: 1, name: "Coaching workspace (coaches & students)" })).toBeTruthy();
    expect(screen.getByText(/The steps in this article happen in your account/)).toBeTruthy();
  });

  it("files both under Reviews & coaching on the hub", () => {
    render(<HelpHubPage />);
    const card = document.getElementById("reviews-coaching") as HTMLElement;
    expect(within(card).getByRole("heading", { level: 3, name: "Reviews & coaching" })).toBeTruthy();
    expect(within(card).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/help/replay-reviews",
      "/help/coaching",
    ]);
  });

  it("hides the sign-in note once signed in", async () => {
    auth.signedIn = true;
    await renderArticle("build-check-in");
    expect(screen.queryByText(/The steps in this article happen in your account/)).toBeNull();
  });
});
