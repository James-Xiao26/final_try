// One-off backfill of the closed-positions archive (migration 031).
//
//   pnpm --filter edgeboard-scripts exec tsx archiveBackfill.ts [days]   # default 365
//
// The daily ingest only archives what's in its ~90-day scoring window, so the archive starts shallow
// and deepens by ~1 day per day. This backfill seeds it immediately: for every current leaderboard
// wallet it pulls up to `days` of /closed-positions (deeper than the daily 90d cutoff) and upserts them
// into closed_positions_archive with ignoreDuplicates (first-seen wins — a resolved position is
// immutable). Gives the cross-theme persistence analysis (crossThemePersistence.ts) a year of distinct
// market themes in one pass instead of waiting a year.
//
// Best-effort: the /closed-positions pagination is still capped at MAX_CLOSED_POSITION_PAGES pages
// (~2000 newest positions per wallet), so a hyper-active wallet's oldest history may truncate. Re-run
// safe (ignoreDuplicates). Ad-hoc, no scheduler — run it once after applying migration 031.
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { PolymarketClient } from "./polymarket.js";

loadEnv({ path: "../.env.local" });
loadEnv();

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const supabase = createClient(requiredEnv("NEXT_PUBLIC_SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
const INSERT_CHUNK = 500;

async function boardAddresses(): Promise<string[]> {
  const { data, error } = await supabase.from("leaderboard_cache").select("address");
  if (error) throw error;
  return [...new Set((data ?? []).map((r: { address: string }) => r.address))];
}

async function main(): Promise<void> {
  const days = Number(process.argv[2]) || 365;
  const addresses = await boardAddresses();
  const client = new PolymarketClient();
  console.log(`Backfilling ${days}d of closed positions for ${addresses.length} board wallets...`);

  let wallets = 0;
  let archived = 0;
  for (const address of addresses) {
    const positions = await client.getClosedPositions(address, days);
    const rows = positions
      .filter((p) => p.closeTime)
      .map((p) => ({
        address,
        condition_id: p.conditionId,
        outcome_index: p.outcomeIndex,
        close_time: p.closeTime,
        market: p.market,
        avg_price: p.avgPrice,
        realized_pnl: p.realizedPnl,
        size: p.size,
        outcome: p.outcome,
        event_slug: p.eventSlug
      }));
    for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK) {
      const { error } = await supabase
        .from("closed_positions_archive")
        .upsert(rows.slice(offset, offset + INSERT_CHUNK), {
          onConflict: "address,condition_id,outcome_index,close_time",
          ignoreDuplicates: true
        });
      if (error) throw error;
    }
    archived += rows.length;
    wallets += 1;
    if (wallets % 25 === 0) console.log(`  ${wallets}/${addresses.length} wallets, ${archived} rows upserted so far`);
  }
  console.log(`Done. Upserted ${archived} rows across ${wallets} wallets (duplicates ignored).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
