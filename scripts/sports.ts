// Strict sports keyword gate for the copy list. Shared by the elite-wallet sports filter (eliteWallets)
// and the copylist market gate (copyList/copylistForward) — its own module so both can import it without
// a circular value import (copyCandidates <-> eliteWallets already type-import each other).
//
// Purpose-built and richer than specialty.ts's shared Sports keywords (those are tuned for the site's
// wallet chips and miss soccer/tennis/etc.), so a copylist gated on this is TRULY sports-only. Only
// unambiguous sports terms — no bare "vs" (would catch "Trump vs Biden") — so a stray political market
// can't leak in. Real Polymarket sports events carry the league/tournament in the title or event slug.
//
// ponytail: keyword heuristic. A sports market whose every text lacks a league/sport term (a bare
// "Team A vs Team B" event with no competition named) slips through. Upgrade path = a condition_id ->
// Gamma sports-tag map cached during ingest:markets, same upgrade noted in specialty.ts.
const SPORTS_RE =
  /\b(nba|nfl|nhl|mlb|ncaa|ncaaf|ncaab|ufc|mma|boxing|wnba|mls|epl|efl|premier league|la liga|serie a|bundesliga|ligue ?1|champions league|europa league|world cup|fifa|uefa|conmebol|copa|euro 20\d\d|super bowl|playoffs?|grand slam|wimbledon|roland garros|us open|atp|wta|tennis|golf|pga|the masters|ryder cup|formula ?1|f1|grand prix|motogp|nascar|cricket|ipl|rugby|olympics?|soccer|football|basketball|baseball|hockey)\b/i;

// True if ANY provided text (market question, event title, event slug) reads as sports. Event slugs are
// hyphenated ("fifa-world-cup-argentina-egypt"), so hyphens/underscores are spaced before matching.
export function isSportsText(...texts: (string | null | undefined)[]): boolean {
  return texts.some((t) => t != null && SPORTS_RE.test(t.replace(/[-_]/g, " ")));
}
