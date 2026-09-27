import { Award, ShieldCheck, ShieldQuestion } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { verifiedLabel, type ReviewCommentAuthor } from "@/lib/reviews";

/**
 * Who wrote a review: the league band + race VERIFIED from the
 * reviewer's own synced ladder games (never self-reported; "Unverified"
 * otherwise), plus their karma badges and flair.
 */
export function ReviewerBadges({ author }: { author: ReviewCommentAuthor }) {
  if (author.isAsker) {
    return <Badge variant="accent" size="sm">Asker</Badge>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {author.verified ? (
        <Badge variant="cyan" size="sm" iconLeft={<ShieldCheck className="h-3 w-3" aria-hidden />} title="Verified from this reviewer's own ladder games">
          {verifiedLabel(author.verified)}
        </Badge>
      ) : (
        <Badge variant="neutral" size="sm" iconLeft={<ShieldQuestion className="h-3 w-3" aria-hidden />} title="No verified ladder band yet">
          Unverified
        </Badge>
      )}
      {author.flair ? (
        <Badge variant="signal" size="sm" iconLeft={<Award className="h-3 w-3" aria-hidden />}>{author.flair}</Badge>
      ) : null}
      {author.badges
        .filter((b) => !(author.flair && b.key === "mentor"))
        .slice(-2)
        .map((b) => (
          <Badge key={b.key} variant="neutral" size="sm">{b.label}</Badge>
        ))}
    </span>
  );
}
