import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

// load env from .env.local without a dep
for (const line of readFileSync("C:/Users/Jimmy/dev/edgeboard/.env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const tables = [
  "wallets", "wallet_stats", "leaderboard_cache", "equity_curve",
  "recent_trades", "wallet_trades", "wallet_positions", "wallet_closed_positions",
  "markets", "market_price_history", "market_price_meta", "candidate_wallets",
  "crowded_markets_cache", "fresh_entries_cache", "waitlist",
];

const rows = [];
for (const t of tables) {
  const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
  rows.push({ table: t, rows: error ? `ERR ${error.message}` : count });
}
rows.sort((a, b) => (typeof b.rows === "number" ? b.rows : -1) - (typeof a.rows === "number" ? a.rows : -1));
console.table(rows);
