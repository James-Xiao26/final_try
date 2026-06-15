import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mapLiveMarketRow, mergeSeries } from "./polymarketLive";

const SEC = (iso: string) => Date.parse(iso) / 1000;

// A representative Gamma /markets row (string-encoded array fields, like the real API).
function gammaRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    question: "Hurricanes vs. Golden Knights",
    slug: "nhl-car-las-2026-06-14",
    endDate: "2026-06-15T00:00:00Z",
    liquidity: "916929.98",
    volume: "166220.02",
    volume24hr: 67771.21,
    volume1wk: 166220.02,
    spread: 0.01,
    lastTradePrice: 0.53,
    outcomes: '["Hurricanes", "Golden Knights"]',
    outcomePrices: '["0.525", "0.475"]',
    clobTokenIds: '["yes-token-id", "no-token-id"]',
    active: true,
    closed: false,
    image: "https://img/nhl.png",
    ...overrides
  };
}

test("mapLiveMarketRow maps the canonical fields and YES/NO tokens", () => {
  const live = mapLiveMarketRow(gammaRow());
  assert.ok(live);
  assert.equal(live.yesTokenId, "yes-token-id");
  assert.equal(live.noTokenId, "no-token-id");
  assert.equal(live.meta.question, "Hurricanes vs. Golden Knights");
  assert.equal(live.meta.slug, "nhl-car-las-2026-06-14");
  assert.equal(live.meta.endDate, "2026-06-15T00:00:00Z");
  assert.equal(live.meta.liquidityUsd, 916929.98);
  assert.equal(live.meta.volume24hrUsd, 67771.21);
  assert.equal(live.meta.spread, 0.01);
  assert.equal(live.meta.active, true);
  assert.equal(live.meta.closed, false);
  // Favored outcome = highest implied price.
  assert.equal(live.meta.topOutcome, "Hurricanes");
  // Sports slug → coarse category when the row carries no tags.
  assert.equal(live.meta.category, "NHL");
});

test("mapLiveMarketRow picks the favored outcome regardless of order", () => {
  const live = mapLiveMarketRow(gammaRow({ outcomePrices: '["0.2", "0.8"]' }));
  assert.equal(live?.meta.topOutcome, "Golden Knights");
});

test("mapLiveMarketRow captures groupItemTitle for a grouped-event leg", () => {
  // A grouped leg ("Spain" in "World Cup Winner") is itself a Yes/No market, so topOutcome is Yes/No —
  // groupItemTitle is the only signal that it belongs to a multi-candidate event.
  const leg = mapLiveMarketRow(gammaRow({ groupItemTitle: "Spain", outcomes: '["Yes", "No"]', outcomePrices: '["0.16", "0.84"]' }));
  assert.equal(leg?.groupItemTitle, "Spain");
  assert.equal(leg?.meta.topOutcome, "No");
  // A plain binary market carries no group title.
  const plain = mapLiveMarketRow(gammaRow());
  assert.ok(plain);
  assert.equal(plain.groupItemTitle, null);
});

test("mapLiveMarketRow falls back to event slug/image and clob volume keys", () => {
  const live = mapLiveMarketRow(
    gammaRow({
      slug: undefined,
      image: undefined,
      icon: undefined,
      volume: undefined,
      volume24hr: undefined,
      events: [{ slug: "ev-slug", image: "https://img/ev.png", category: "Sports" }],
      volumeClob: "500",
      volume24hrClob: 12
    })
  );
  assert.equal(live?.meta.slug, "ev-slug");
  assert.equal(live?.meta.image, "https://img/ev.png");
  assert.equal(live?.meta.category, "Sports"); // event category wins over slug derivation
  assert.equal(live?.meta.volumeUsd, 500);
  assert.equal(live?.meta.volume24hrUsd, 12);
});

test("mapLiveMarketRow degrades safely on an empty / malformed row", () => {
  assert.equal(mapLiveMarketRow(null), null);
  const bare = mapLiveMarketRow({});
  assert.ok(bare);
  assert.equal(bare.meta.question, "Untitled market");
  assert.equal(bare.yesTokenId, null);
  assert.equal(bare.noTokenId, null);
  assert.equal(bare.meta.liquidityUsd, 0);
  assert.equal(bare.meta.outcomes, null);
  assert.equal(bare.meta.topOutcome, null);
});

test("mergeSeries takes the finest series available in each time region", () => {
  // daily covers the whole life; hourly starts Jun 12; minute starts Jun 13.
  const daily = [
    { t: SEC("2026-06-10T00:00:00Z"), p: 0.40 },
    { t: SEC("2026-06-11T00:00:00Z"), p: 0.50 },
    { t: SEC("2026-06-12T00:00:00Z"), p: 0.55 }, // dropped — hourly covers Jun 12
    { t: SEC("2026-06-13T00:00:00Z"), p: 0.60 } // dropped — minute covers Jun 13
  ];
  const hourly = [
    { t: SEC("2026-06-12T01:00:00Z"), p: 0.52 },
    { t: SEC("2026-06-12T05:00:00Z"), p: 0.58 },
    { t: SEC("2026-06-13T02:00:00Z"), p: 0.61 } // dropped — minute covers Jun 13
  ];
  const minute = [
    { t: SEC("2026-06-13T00:10:00Z"), p: 0.59 },
    { t: SEC("2026-06-13T00:20:00Z"), p: 0.63 }
  ];
  const pts = mergeSeries([daily, hourly, minute]);
  // The boundary is the next finer series' START timestamp: daily keeps everything before hourly's
  // first point (Jun 12 00:00 included, as it precedes hourly's 01:00); hourly keeps Jun 12 up to
  // minute's first point; minute owns the rest. Jun 13 daily/hourly points are dropped.
  assert.equal(pts.length, 7);
  assert.deepEqual(pts.map((p) => p.price), [0.4, 0.5, 0.55, 0.52, 0.58, 0.59, 0.63]);
  assert.equal(pts[0]?.ts, "2026-06-10T00:00:00.000Z"); // full ISO (intraday)
});

test("mergeSeries inverts a NO token to YES and skips malformed points", () => {
  const pts = mergeSeries(
    [[{ t: SEC("2026-06-10T00:00:00Z"), p: 0.3 }, { t: Number.NaN, p: 0.9 }, { t: 1, p: Number.NaN }]],
    true
  );
  assert.equal(pts.length, 1);
  assert.equal(Number(pts[0]?.price.toFixed(4)), 0.7); // 1 − 0.3
});

test("mergeSeries falls back to coarser series when finer ones are empty", () => {
  const daily = [{ t: SEC("2026-06-10T00:00:00Z"), p: 0.4 }, { t: SEC("2026-06-11T00:00:00Z"), p: 0.5 }];
  const pts = mergeSeries([daily, [], []]);
  assert.deepEqual(pts.map((p) => p.price), [0.4, 0.5]);
});

test("mergeSeries: an empty middle series doesn't make the coarse series overlap the fine one", () => {
  // hourly is empty but minute has data — daily must still be bounded by minute's start, not overlap it.
  const daily = [
    { t: SEC("2026-06-10T00:00:00Z"), p: 0.4 },
    { t: SEC("2026-06-13T06:00:00Z"), p: 0.6 } // dropped — falls inside minute's window (after its start)
  ];
  const minute = [{ t: SEC("2026-06-13T00:10:00Z"), p: 0.59 }, { t: SEC("2026-06-13T00:20:00Z"), p: 0.63 }];
  const pts = mergeSeries([daily, [], minute]);
  assert.deepEqual(pts.map((p) => p.price), [0.4, 0.59, 0.63]);
});
