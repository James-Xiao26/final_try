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
// Two matchers, both applied to a hyphen/underscore→space-normalized copy of each text (so an event
// slug like "fifwc-usa-bel-2026-07-06" or "nba-giannis-next-team" tokenizes into words):
//   LEAGUE — league/sport/tournament names AND Polymarket's sport slug-prefix codes. Team names and a
//            bare "vs" are deliberately NOT here (a matchup title like "Athletics vs. Detroit Tigers"
//            has no league word — it's caught via its event slug, e.g. "mlb-ath-det-...", instead), so
//            politics ("Trump vs Biden") can't leak in.
const LEAGUE_RE =
  /\b(nba|wnba|nfl|nhl|mlb|kbo|npb|ncaa|ncaaf|ncaab|cfb|cbb|ufc|mma|boxing|mls|epl|efl|fa cup|carabao|laliga|la liga|seriea|serie a|bundesliga|ligue ?1|ligue1|eredivisie|primeira|ucl|uel|conference league|champions league|europa league|world cup|fifwc|fifa|uefa|conmebol|concacaf|copa|libertadores|euro 20\d\d|super bowl|super ?cup|playoffs?|grand slam|wimbledon|roland garros|australian open|us open|atp|wta|tennis|golf|pga|liv golf|the masters|ryder cup|formula ?1|formula1|f1|grand prix|motogp|nascar|indycar|cricket|ipl|bbl|test match|rugby|nrl|afl|olympics?|soccer|football|basketball|baseball|hockey|dota ?2?|counter[- ]?strike|csgo|cs2|valorant|league of legends|lol|lck|lpl|lec|lcs|overwatch|rocket league|call of duty|starcraft)\b/i;

// True if ANY provided text (market question, event title, event slug) reads as sports.
export function isSportsText(...texts: (string | null | undefined)[]): boolean {
  return texts.some((t) => t != null && LEAGUE_RE.test(t.replace(/[-_]/g, " ")));
}
