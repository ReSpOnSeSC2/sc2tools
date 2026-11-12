# Draft to the SC2Pulse maintainer

**Subject** · Permission to publish SC2Pulse-derived ladder balance summaries on SC2 Tools

Hi,

I maintain SC2 Tools at sc2tools.com. I'd like to publish a ladder balance page and a cacheable JSON endpoint that summarize the three non-mirror matchups by league tier. The site accepts donations and has a coaching section. May we collect and retain snapshots from your balance-reports API and republish derived aggregate counts, win rates and Wilson intervals on this site?

The collector would make up to 19 serial requests per night, paced at two-second intervals, with a User-Agent identifying SC2 Tools and linking to a contact page. The page and its downloadable summaries would link to SC2Pulse and credit it as the data source. We plan to retain the latest complete tier snapshots and coarse daily rollups. The public output would contain aggregate counts only. Would that use, including future share cards that quote the published figures with the same credit, be acceptable? Please let me know your preferred wording and any limits on caching, retention, request volume or republication.

I also want to make sure we describe the data correctly.

- How is a cross-tier game assigned to a tier? Can it appear under both players' tiers?
- What does a frame with `number: null` represent? Is it a disjoint group of games that should be included in all-duration totals?
- Does `wins` count the first race in the matchup? Do the counts cover all ranked games or the games SC2Pulse tracks?

We'll keep same-tier and cross-tier counts separate and use only same-tier figures for the league-tier headline. Thanks for your time and for making this data available.
