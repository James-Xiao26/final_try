# Polymarket Docs Notes

Notes from a full pass over every tab of **docs.polymarket.com** (2026-07-04). Structure pulled from `docs.polymarket.com/llms.txt` (the machine-readable index — fastest way to see the whole site); substantive notes fetched from the conceptual/overview pages. Endpoint pages are just parameter references and are listed by URL, not transcribed.

There is a separate **US** docs site at `docs.polymarket.us` (Polymarket US, not covered here).

---

## 1. The four APIs (base hosts)

| API | Host | Auth | Purpose |
|-----|------|------|---------|
| **Gamma** | `gamma-api.polymarket.com` | none | Markets, events, tags, series, comments, sports, search, public profiles. Discovery/browsing. |
| **Data** | `data-api.polymarket.com` | none | User positions, trades, activity, holders, open interest, leaderboards, analytics. |
| **CLOB** | `clob.polymarket.com` | public read / L2 for trading | Orderbook, pricing, midpoints, spreads, price history; order placement + cancel. |
| **Bridge** | `bridge.polymarket.com` | — | Deposits/withdrawals proxy. |

Gamma + Data need no credentials. CLOB read endpoints are public; trading requires auth.

**These are exactly the three hosts EdgeBoard uses** (Data + Gamma + CLOB), each its own Cloudflare rate bucket — matches CLAUDE.md.

---

## 2. Core concepts

### Markets vs Events
- **Market** = one binary Yes/No question, the fundamental tradable unit.
- **Event** = container grouping one or more related markets (e.g. an election with one market per candidate → mutually-exclusive multi-market event). Single-market events pair 1 market ≈ 1 event.
- `enableOrderBook` must be true for CLOB trading; some onchain markets exist without an orderbook.

### Identifiers (per market)
- **Condition ID** — unique id for the market's condition in the CTF contracts. *(EdgeBoard's `condition_id`.)*
- **Question ID** — hash of the market question, used for resolution.
- **Token IDs** — the two ERC1155 tokens (Yes + No) traded on the CLOB. *(EdgeBoard's YES token / outcome-token ids.)*
- **Slug** — human-readable id in URLs, e.g. `polymarket.com/event/fed-decision-in-october`. Queryable in Gamma.

### Positions & tokens
- Two outcome tokens (Yes/No), **ERC1155 on Polygon via Gnosis Conditional Token Framework (CTF)**, each a claim on $1 collateral.
- Redemption: winning token → **$1.00**, losing → **$0.00**, rare 50/50 → $0.50 each.
- **Split**: pUSD → balanced pair ($100 → 100 Yes + 100 No). **Merge**: equal Yes+No → pUSD. **Redeem**: after resolution, winning tokens → $1 each.
- Position value = token balance × current price (100 Yes @ $0.75 = $75).
- ~4.00% annualized holding rewards on eligible positions, sampled hourly, paid daily.

### Prices & orderbook
- Price ∈ $0.00–$1.00 = **market-implied probability** ($0.75 = 75%).
- Displayed price = **midpoint of bid/ask**; if spread > $0.10, shows **last traded price** instead.
- Bids = buy orders (highest buyers pay), asks = sell orders (lowest sellers accept); gap = spread; tighter = more liquid.
- Market orders fill immediately (pay ask / receive bid); limit orders rest until matched, can partial-fill/cancel.
- New markets start priceless; price emerges when Yes + No limit orders sum to $1.00.

### Order lifecycle
- All orders are **limit orders** = EIP-712-signed messages (non-custodial). Types:
  - **GTC** good-till-cancelled, **GTD** good-till-date, **FOK** fill-or-kill, **FAK** fill-and-kill. Post-only rejects if it would match (guarantees maker).
- Matching delays: **taker delay** 250ms on select crypto/finance markets; **sports delay** on live-game markets.
- Order statuses: `live`, `matched`, `delayed`, `unmatched`.
- Trade statuses: `MATCHED` → `MINED` → `CONFIRMED` (terminal); alt `RETRYING`, `FAILED` (terminal).
- Settlement is atomic onchain on Polygon (Exchange contract verifies sig, swaps tokens ↔ pUSD).

### Resolution
- Uses the **UMA Optimistic Oracle**. Anyone proposes an outcome + posts a bond (~$750 pUSD), 2-hour challenge window.
  - Undisputed: ~2h. One dispute: re-proposal. Two disputes: UMA token-holder vote (~4–6 days).
- Winning tokens redeemable $1.00 via CTF collateral adapter (burns tokens → pUSD). "Always read the resolution rules before trading."

### pUSD
- **pUSD** = collateral token for all trading; ERC-20 on Polygon, 6 decimals, a wrapper around **USDC.e**, backing enforced onchain (no algorithmic peg). Convert USDC.e → pUSD to trade, back out to withdraw.

---

## 3. Market discovery (Gamma) — 3 strategies
1. **By slug**: `GET /events?slug=` · `/events/slug/{slug}` · `/markets?slug=` · `/markets/slug/{slug}`.
2. **By tags**: `GET /tags`, `GET /sports`, `GET /events?tag_id=` (+ `related_tags=true`, `exclude_tag_id`).
3. **Via events (recommended, most efficient)**: `GET /events?active=true&closed=false&limit=100`, order by volume/liquidity/dates, `limit`/`offset` paging. Docs advise: start from events and work backwards (events contain their markets → fewer calls). *(This is EdgeBoard's `ingestMarkets` one-global-`/events`-pass approach.)*

---

## 4. Rate limits (per 10s window unless noted)

**Gamma** (`gamma-api`): general 4,000; `/events` 500; `/markets` 300; markets+events listing 900; `/comments` 200; `/tags` 200; `/public-search` 350.

**Data** (`data-api`): general 1,000; `/trades` 200; **`/positions` 150; `/closed-positions` 150** (the binding lane for EdgeBoard); health 100.

**CLOB** (`clob`): general 9,000; `/book`,`/price`,`/midpoint` 1,500 each; `/books`,`/prices`,`/midpoints` 500 each; **`/prices-history` 1,000**; tick-size 200; ledger `/trades`,`/orders`,`/order` 900; API-key endpoints 100. Trading: `POST/DELETE /order` 5,000/10s burst, 120,000/10min.

**Bridge**: 50. **Relayer `/submit`**: 25/1min. **User PNL API**: 200.

Confirms CLAUDE.md: restricted lane (positions/closed-positions, 150/10s) is the bottleneck; general Data 1,000; CLOB prices-history 1,000.

---

## 5. Authentication (CLOB trading only — EdgeBoard doesn't use this, read-only)
- **L1** (private key): sign EIP-712, non-custodial, used to create credentials + sign orders.
- **L2** (API key): `apiKey` (UUID) + `secret` (base64) + `passphrase`, from `createOrDeriveApiKey()`; HMAC-SHA256 signed requests.
- L2 headers: `POLY_ADDRESS`, `POLY_API_KEY`, `POLY_PASSPHRASE`, `POLY_SIGNATURE`, `POLY_TIMESTAMP`. Order creation still needs the per-order EIP-712 signature on top of L2. New users: signature type `POLY_1271` + deposit wallets.

---

## 6. Full tab / section map (every URL, from llms.txt)

### API Reference
- **Intro/SDKs**: `/api-reference/introduction`, `/api-reference/clients-sdks`
- **Auth & access**: `authentication`, `geoblock`, `rate-limits`
- **Core user data** (Data API — EdgeBoard's bread & butter): `core/get-closed-positions-for-a-user`, `get-current-positions-for-a-user`, `get-positions-for-a-market`, `get-top-holders-for-markets`, `get-total-value-of-a-users-positions`, `get-trader-leaderboard-rankings`, `get-trades-for-a-user-or-markets`, `get-user-activity`, `get-user-combo-activity`, `get-user-combo-positions`
- **Markets** (Gamma/CLOB): `markets/get-batch-prices-history`, `get-clob-market-info`, `get-market-by-id`, `get-market-by-slug`, `get-market-by-token`, `get-market-tags-by-id`, `get-prices-history`, `get-sampling-markets`, `get-sampling-simplified-markets`, `get-simplified-markets`, `list-markets`, `list-markets-keyset-pagination`
- **Events**: `events/get-event-by-id`, `get-event-by-slug`, `get-event-tags`, `list-events`, `list-events-keyset-pagination`
- **Market data (CLOB pricing)**: `market-data/` — fee-rate, last-trade-price(s), market-price(s), midpoint(s), order-book(s), spread(s), tick-size (query-param + request-body + path-param variants)
- **Data (misc pricing)**: `data/get-midpoint-price`, `data/get-server-time`
- **Trading**: `trade/` — post/cancel orders (single/multiple/all/by-market), get-trades, get-user-orders, get-single-order, get-order-scoring-status, get-builder-trades, send-heartbeat
- **Maker (RFQ)**: `maker/submit-a-quote`, `cancel-a-quote`, `confirm-or-decline-last-look`
- **Combo markets**: `combo-markets/get-combo-markets`
- **WebSocket (wss)**: `wss/market`, `wss/user`, `wss/sports`, `wss/rfq`
- **Search**: `search/search-markets-events-and-profiles`
- **Series**: `series/get-series-by-id`, `list-series`
- **Sports**: `sports/get-sports-metadata-information`, `get-valid-sports-market-types`, `list-teams`
- **Tags**: `tags/` — list, get-by-id/slug, related-tags (by id/slug, both directions)
- **Profiles**: `profiles/get-public-profile-by-wallet-address`
- **Misc**: `misc/download-an-accounting-snapshot`, `get-live-volume-for-an-event`, `get-open-interest`, `get-total-markets-a-user-has-traded`
- **Rewards**: `rewards/` — active configs, earnings-by-date, markets-with-rewards, raw-rewards, reward-percentages, total-earnings, user-earnings-config
- **Rebates**: `rebates/get-current-rebated-fees-for-a-maker`
- **Builders**: `builders/get-aggregated-builder-leaderboard`, `get-daily-builder-volume-time-series`
- **Bridge**: `bridge/` — create-bridge/withdrawal-addresses, get-a-quote, get-supported-assets, get-transaction-status
- **Relayer**: `relayer/` — check-wallet-deployed, get-transaction-by-id, get-current-nonce, get-recent-transactions, get-relayer-address-and-nonce, submit-a-transaction; `relayer-api-keys/get-all-relayer-api-keys`
- **Advanced**: `advanced/neg-risk` (Negative Risk Markets — capital-efficient multi-outcome)

### Developer Resources
- **Getting started**: `index`, `polymarket-101`, `quickstart`
- **Concepts**: `concepts/markets-events`, `positions-tokens`, `prices-orderbook`, `order-lifecycle`, `pusd`, `resolution`
- **Market data guide**: `market-data/overview`, `fetching-markets`, `websocket/overview`, `websocket/market-channel`, `websocket/user-channel`, `websocket/sports`, `websocket/rtds` (real-time data socket: comments/crypto/equity prices)
- **Dev tooling**: `dev-tooling`, `dev-tooling/python`, `dev-tooling/typescript` (unified SDKs)
- **Market makers**: `market-makers/overview`, `getting-started`, `trading`, `inventory`, `combos`, `liquidity-rewards`, `maker-rebates`
- **Builders**: `builders/overview`, `api-keys` (builder code), `fees`, `tiers`
- **Resources**: `resources/blockchain-data`, `contracts` (addresses + audits), `error-codes` (CLOB errors), `referral-program`

### Trading Guides
- **Fundamentals**: `trading/overview`, `quickstart`, `orderbook`, `fees`, `gasless`, `deposit-wallets`, `matching-engine`, `taker-rebates`
- **Orders**: `trading/orders/overview`, `create`, `cancel`, `attribution`
- **Clients**: `trading/clients/public` (read-only), `l1` (wallet signer), `l2` (API creds), `builder`
- **CTF (Conditional Token Framework)**: `trading/ctf/overview`, `split`, `merge`, `redeem`
- **Bridge**: `trading/bridge/deposit`, `quote`, `status`, `supported-assets`, `withdraw`

### API specs (machine-readable)
- OpenAPI: `data-openapi.yaml`, `bridge-openapi.yaml`, `clob-openapi.yaml`, `combos-rfq-openapi.yaml`, `gamma-openapi.yaml`, `relayer-openapi.yaml`, `openapi.json`
- Per-endpoint JSON specs under `developers/open-api/`: get-holders, get-book, get-trades, get-activity, get-markets, get-value, get-positions, get-prices-history, get-price, get-events, connect-wss
- AsyncAPI (WebSocket): `asyncapi.json`, `asyncapi-user.json`, `asyncapi-rfq.json`, `asyncapi-sports.json`

### External links
- Builder Program `builders.polymarket.com` · Help `help.polymarket.com` · Status `status.polymarket.com`

---

## 7. Things new since EdgeBoard was built (worth noting)
- **pUSD** is now the settlement/collateral token (wrapper over USDC.e) — docs consistently say pUSD, not USDC.
- **Combo markets** + **Negative Risk markets** exist as first-class multi-outcome constructs, with dedicated Data-API endpoints (`get-user-combo-positions`, `get-user-combo-activity`, `get-combo-markets`).
- **Builder program** (order attribution via builder code → fee share) — relevant only if EdgeBoard ever routes orders.
- **Keyset (cursor) pagination** variants now exist for `list-events` and `list-markets` — cheaper than offset for large sweeps if ingest paging ever needs it.
- **`get-top-holders-for-markets`** endpoint exists — could simplify EdgeBoard's crowd/whale-concentration logic (currently derived from scanning positions).
- **RTDS websocket** streams comments/crypto/equity prices; **sports websocket** streams live scores.
