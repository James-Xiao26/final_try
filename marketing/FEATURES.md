# WhaleWatcher — Feature Reference (for marketing/post writing)

Plain-language list of what a visitor can actually do on the site, written so it's
easy to pull findings and talking points for Reddit/marketing posts. This is the
**product** view, not the architecture (that lives in `CLAUDE.md`).

Site: https://www.getwhalewatcher.me — **free, no paywall.** Sign-in (Google, no
password) unlocks a few panels but most of the site is open.

## The core idea (the one-liner)

Most Polymarket leaderboards rank by profit, which mostly tells you who bet the
most. WhaleWatcher ranks by **forecasting edge**: how reliably a trader's entry
price beats where the market actually settles. It's the same concept as **CLV
(closing line value)** in sports betting, applied to prediction-market wallets.

## Skill Score (the headline number)

- Every ranked wallet gets a **0-10 Skill Score**.
- It measures **edge per share**: how far below the eventual settlement price the
  trader bought in, on average. Higher = they consistently get a better number
  than where the market closes.
- **Bayesian-shrunk for sample size** — a wallet that went 5-for-5 on luck can't
  top the board; it takes a real sample of good calls.
- Pure skill, **not profit**. A whale with huge PnL can have a mediocre score, and
  a smaller account can rank #1. (This contrast is the best post hook.)
- Two time windows: **30-day and 90-day** leaderboards.

## Anti-gaming filters (why the board is "clean")

- **Bots excluded** — wallets flagged as bots are kept off the board.
- **Scalpers/fast-flippers excluded** — accounts that just churn sub-hour
  round-trips (e.g. BTC 15-min markets) are filtered, because that edge isn't
  copyable. Skill Score is about *copyable* forecasting skill.
- **Recency gate** — an account needs ~14+ days of history to rank, so a hot
  6-day account can't top the board on a lucky week.

## Specialty chips

- Each wallet shows the **market category it forecasts best**: Politics, Crypto,
  Sports, Economy, Geopolitics, or Culture.
- Good post angle: "this account is elite at Politics and bad at Crypto" — the
  per-category edge makes that visible.

## Per-wallet detail page

Open any wallet (`/wallet/<address>`) to see:
- **Open positions** — what they're currently holding.
- **Closed positions with P/L** — their realized results.
- **Copy-trade equity curve** — "what if I'd started with $100 and staked 1% of my
  balance to copy every trade this wallet made?" Shown as % return vs the $100
  stake. Some curves look great, some look rough — that contrast is itself a
  talking point.

## Markets page

- A browsable list of markets with the most-favored outcome, 24h change, category,
  and status. Public (works as a teaser without signing in).

## Convergence / "crowded markets" (sign-in to unlock)

- Shows **which markets the smartest wallets are all piling into right now**,
  ranked by how many distinct leaderboard wallets hold them, with a YES/NO split
  and how much capital is committed.
- This is the most "actionable today" feature — good for FOMO-driven clicks.
- Each market has a detail page (see below).

## Market Analytics page (`/market/<id>`, sign-in to unlock)

Click any market for a deep dive:
- **Interactive price chart** — full-resolution YES price line with hover
  crosshair/tooltip.
- **Whale trades overlaid** on the line — notable fills plotted at their price so
  you can see big buys/sells against the move.
- **Regime-shift markers** — where the price meaningfully changed character.
- **Concentration** — top-holder share and how concentrated the market is.
- **P/L histogram** — distribution of wins/losses across holders + win rate.
- **3-way smart-money lean** — which side the crowd favors by headcount, by
  capital, and by skill (skill-weighted is the interesting one).
- **Per-wallet participants** — who's in the market, which side, their fills.
- For grouped events (e.g. "World Cup Winner"), the chart overlays the **top-3
  favored candidates** as separate lines.
- Resolved markets show a banner: winning side + whether the skill-weighted smart
  money actually called it.

## Recent-trades activity feed

- Live-ish feed of what leaderboard wallets are buying/selling (refreshes ~every
  10 min).

## Signals page (`/decision`, sign-in to unlock)

- A decision/signals surface derived from the same data. (Codename "Signals.")

## Sign-in / gated features

- Login is **Google OAuth, no passwords, free.**
- Signed-in-only: the two home-page panels (**Fresh Contacts** and **Convergence
  Zones**), the **Signals** page, and the per-market **analytics pages**. The
  `/markets` list stays public as a teaser.
- The gate is a sign-up lever, not a paywall — all the data is derived from public
  Polymarket activity.

## Time horizons

- Everything is computed over **30-day and 90-day** windows. (A 365-day view was
  removed.)

## Audience translation cheat-sheet

When writing for a specific subreddit:
- **Polymarket users:** lead with "ranks by skill, not profit," and the #1-by-edge
  vs top-PnL contrast.
- **Sports bettors (r/sportsbook, r/sportsbetting):** lead with **CLV** — Skill
  Score is CLV for prediction markets. Bridge line: Polymarket has lots of sports
  markets now, so these wallets bet the same games with a public track record.
  Translate "edge per share" into "gets in X¢ better than the close."
- **Quant/algo crowd (r/algotrading):** lead with the methodology — Bayesian-shrunk
  per-share edge, sample-size handling, bot/scalper filtering.

## Stock findings to reuse (verify before posting — leaderboard changes)

- The #1 wallet by edge is **not** near the top of the raw-profit board.
- "#1 on the 30-day board averages ~14.5¢ of edge per share" (i.e. buys in ~14.5¢
  below settlement). **Always re-check the live number and say "as of right now,"
  or screenshot it so the post matches.**
