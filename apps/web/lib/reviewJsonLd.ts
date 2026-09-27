import { reviewHeadline, type ReviewComment, type ReviewPageData } from "./reviews";

/**
 * Structured data for an indexable review page: schema.org QAPage
 * (Question → acceptedAnswer = the asker's best review, suggestedAnswer
 * = reviews marked helpful) plus a BreadcrumbList. Only emitted once the
 * quality gate opens (``seo.indexable``); before that the page is
 * noindex and carries no Q&A markup.
 */
export function reviewJsonLd(data: ReviewPageData, siteUrl: string): object[] {
  const r = data.request;
  const pageUrl = `${siteUrl}/reviews/${encodeURIComponent(r.id)}`;
  const headline = reviewHeadline(r.question, r.game.matchup);
  const byId = new Map(data.comments.map((c) => [c.id, c]));
  const answer = (c: ReviewComment) => ({
    "@type": "Answer",
    text: c.body,
    dateCreated: c.createdAt ?? undefined,
    upvoteCount: c.upvotes,
    url: `${pageUrl}#comment-${c.id}`,
    author: { "@type": "Person", name: c.author?.label ?? "SC2 Player" },
  });
  const accepted = data.seo.acceptedAnswerId ? byId.get(data.seo.acceptedAnswerId) : undefined;
  const suggested = data.seo.suggestedAnswerIds
    .map((id) => byId.get(id))
    .filter((c): c is ReviewComment => Boolean(c && c.state === "visible"));
  const question: Record<string, unknown> = {
    "@type": "Question",
    name: headline,
    text: r.question,
    answerCount: data.seo.answerCount,
    dateCreated: r.createdAt ?? undefined,
    author: { "@type": "Person", name: r.asker.label },
  };
  if (accepted && accepted.state === "visible") question.acceptedAnswer = answer(accepted);
  if (suggested.length) question.suggestedAnswer = suggested.map(answer);
  return [
    { "@context": "https://schema.org", "@type": "QAPage", mainEntity: question },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Replay reviews", item: `${siteUrl}/reviews` },
        { "@type": "ListItem", position: 2, name: headline, item: pageUrl },
      ],
    },
  ];
}

/**
 * JSON for a <script type="application/ld+json">. Questions and answers
 * are user text, so "<" is escaped: a "</script>" inside a comment must
 * never close the tag.
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
